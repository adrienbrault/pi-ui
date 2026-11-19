import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimatedTokens, formatRate, type TokenRates } from "../render/tools.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Only request-scoped server measurements can distinguish prefill from queueing and cache reuse. */
export function serverRates(data: unknown) {
  const chunk = object(data);
  const progress = object(chunk?.prompt_progress);
  const timings = object(chunk?.timings);
  const usage = object(chunk?.usage);
  let progressRate: number | undefined;
  if (progress && typeof progress.processed === "number" && typeof progress.cache === "number" && progress.cache >= 0) {
    const elapsed = positive(progress.time_ms);
    if (elapsed) progressRate = positive(((progress.processed - progress.cache) * 1000) / elapsed);
  }
  const promptMs = positive(timings?.prompt_ms);
  const promptTokens = positive(timings?.prompt_n);
  const timedRate = promptMs && promptTokens ? positive((1000 * promptTokens) / promptMs) : undefined;
  return {
    progressRate,
    inputRate:
      positive(timings?.prompt_per_second) ?? positive(usage?.prompt_tokens_per_sec) ?? timedRate ?? progressRate,
    outputRate: positive(timings?.predicted_per_second) ?? positive(usage?.completion_tokens_per_sec),
  };
}

interface MeasuredTurn {
  input?: { toolIds: string[]; rate: number; estimated?: boolean };
  output?: Array<{ id: string; rate: number }>;
}

interface CallStream {
  firstDelta: number;
  subsequentChars: number;
}

/** Result tokens enter the following request. Invocation tokens leave the request that generated the call. */
export function installThroughput(pi: ExtensionAPI, repaint: (id: string) => void) {
  const rates = new Map<string, TokenRates>();
  const streams = new Map<number, CallStream>();
  const liveCalls = new Map<string, number>();
  let resultIds: string[] = [];
  let inputRate: number | undefined;
  let outputRate: number | undefined;
  let progressLabel: string | undefined;
  let generating = false;
  let started: number | undefined;
  let firstOutputMs: number | undefined;
  let incomingTokens = 0;
  let estimated = false;

  function setInput(id: string, rate: number, approximate: boolean, notify = true) {
    const next = { ...rates.get(id), inputRate: rate };
    if (approximate) next.inputRateEstimated = true;
    else delete next.inputRateEstimated;
    rates.set(id, next);
    if (notify) repaint(id);
  }

  function setRate(id: string, direction: keyof TokenRates, value: number, notify = true) {
    const previous = rates.get(id) ?? {};
    if (previous[direction] === value) return;
    rates.set(id, { ...previous, [direction]: value });
    if (notify) repaint(id);
  }

  function showProgress(ctx: ExtensionContext, label?: string) {
    if (progressLabel === label) return;
    progressLabel = label;
    ctx.ui.setStatus("prism-prefill", label);
  }

  function reset(ctx: ExtensionContext) {
    streams.clear();
    liveCalls.clear();
    inputRate = undefined;
    outputRate = undefined;
    generating = false;
    started = undefined;
    firstOutputMs = undefined;
    incomingTokens = 0;
    estimated = false;
    showProgress(ctx);
  }

  function restore(ctx: ExtensionContext) {
    reset(ctx);
    rates.clear();
    resultIds = [];
    if (ctx.mode !== "tui") return;
    let latest: MeasuredTurn | undefined;
    for (const entry of ctx.sessionManager?.getBranch() ?? []) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const saved = (entry.message as { prismThroughput?: MeasuredTurn }).prismThroughput;
      latest = saved;
      if (saved?.input)
        for (const id of saved.input.toolIds) setInput(id, saved.input.rate, !!saved.input.estimated, false);
      for (const call of saved?.output ?? []) setRate(call.id, "outputRate", call.rate, false);
    }
    showLastPrefill(ctx, latest);
  }

  // A prompt without tool results has no member row on which to retain the reading.
  function showLastPrefill(ctx: ExtensionContext, turn?: MeasuredTurn) {
    if (turn?.input && turn.input.toolIds.length === 0) {
      showProgress(ctx, `last prefill ${formatRate(turn.input.rate)} tok/s${turn.input.estimated ? " est." : ""}`);
    }
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    reset(ctx);
    rates.clear();
    resultIds = [];
  });
  pi.on("context_with_system", ({ messages }) => {
    // Earlier tool results are already accounted for even when the entire history is resent.
    const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
    resultIds = messages
      .slice(lastAssistant + 1)
      .flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
  });
  pi.on("before_provider_request", ({ payload }, ctx) => {
    reset(ctx);
    if (ctx.mode !== "tui" || ctx.model?.api !== "openai-completions") return;
    // These are llama-server request extensions. Generic OpenAI-compatible endpoints may reject them.
    const llama =
      ["llama.cpp", "llama-cpp", "llamacpp"].includes(ctx.model.provider) ||
      process.env.PI_PRISM_LLAMA_TIMINGS === ctx.model.provider;
    const body = object(payload);
    if (body?.stream && Array.isArray(body.messages)) {
      // Assume the previous conversation prefix was reused for this client-side estimate.
      const messages = body.messages.map(object);
      const suffix = messages.slice(messages.findLastIndex((m) => m?.role === "assistant") + 1);
      for (const message of suffix) {
        const content = message?.content;
        if (typeof content === "string") incomingTokens += estimatedTokens(content.length);
        else if (Array.isArray(content))
          for (const part of content)
            if (typeof part?.text === "string") incomingTokens += estimatedTokens(part.text.length);
      }
      started = performance.now();
    }
    if (llama && body?.stream === true) return { ...body, return_progress: true, timings_per_token: true };
  });
  pi.on("provider_stream_event", ({ data }, ctx) => {
    if (ctx.mode !== "tui") return;
    const sample = serverRates(data);
    if (sample.inputRate) {
      inputRate = sample.inputRate;
      estimated = false;
      for (const id of resultIds) setInput(id, inputRate, false);
    }
    if (sample.outputRate) outputRate = sample.outputRate;
    if (sample.progressRate && !generating) showProgress(ctx, `prefill ${formatRate(sample.progressRate)} tok/s`);
  });
  pi.on("message_update", ({ message, assistantMessageEvent: event }, ctx) => {
    if (message.role !== "assistant" || ctx.mode !== "tui") return;
    if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
      if (!generating && event.delta && started !== undefined) {
        firstOutputMs = positive(performance.now() - started);
        if (!inputRate && firstOutputMs && incomingTokens) {
          inputRate = (1000 * incomingTokens) / firstOutputMs;
          estimated = true;
          for (const id of resultIds) setInput(id, inputRate, true);
        }
      }
      if (event.delta) {
        generating = true;
        showProgress(
          ctx,
          estimated && !resultIds.length && inputRate ? `prefill ${formatRate(inputRate)} tok/s est.` : undefined,
        );
      }
    }
    if (event.type !== "toolcall_delta" || !event.delta) return;
    const call = message.content[event.contentIndex];
    if (call?.type !== "toolCall") return;
    const now = performance.now();
    let stream = streams.get(event.contentIndex);
    if (!stream) {
      stream = { firstDelta: now, subsequentChars: 0 };
      streams.set(event.contentIndex, stream);
    } else {
      stream.subsequentChars += event.delta.length;
    }
    const elapsed = now - stream.firstDelta;
    const rate =
      outputRate ?? (elapsed > 0 ? positive((1000 * estimatedTokens(stream.subsequentChars)) / elapsed) : undefined);
    if (call.id && rate) {
      liveCalls.set(call.id, rate);
      setRate(call.id, "outputRate", rate);
    }
  });
  pi.on("message_end", ({ message }, ctx) => {
    if (message.role !== "assistant" || ctx.mode !== "tui") return;
    const saved: MeasuredTurn = {};
    if (inputRate)
      saved.input = { toolIds: [...resultIds], rate: inputRate, ...(estimated ? { estimated: true } : {}) };
    const calls = message.content.flatMap((call) => {
      if (call.type !== "toolCall") return [];
      // The server's measurement is final; a delta-time estimate only stands in until it arrives.
      const rate = outputRate ?? liveCalls.get(call.id);
      if (!rate) return [];
      setRate(call.id, "outputRate", rate);
      return [{ id: call.id, rate }];
    });
    if (calls.length) saved.output = calls;
    reset(ctx);
    resultIds = [];
    showLastPrefill(ctx, saved);
    if (saved.input || saved.output) return { message: { ...message, prismThroughput: saved } };
  });
  return (id: string) => rates.get(id);
}
