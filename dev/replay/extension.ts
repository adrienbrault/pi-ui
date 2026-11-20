// oxlint-disable no-await-in-loop -- a replay waits one step at a time
/**
 * A pi extension that replays a recorded session, offline, at about the recorded pace. Load it
 * after pi-ui: `pi --no-extensions -e packages/pi-ui/extensions/index.ts -e dev/replay/extension.ts`
 * with `PI_REPLAY_CONFIG` naming a JSON `ReplayConfig`. `bun run replay` does all of this.
 *
 * - A `replay` provider, whose models are the recorded model ids, answers each request with the
 *   next recorded assistant message, streamed delta by delta (see pacing.ts). Which message is
 *   next comes from the request's context: each replayed message carries `responseId:
 *   replay:<index>`, and the answer is the message after the last one in the context.
 * - Every tool the session called, and every built-in tool, is replaced by one that waits the
 *   recorded time, streams a shell command's recorded output line by line, and returns the
 *   recorded result. Nothing reads or writes files or runs commands.
 * - The recorded prompts are sent in order: the first once the driver says go, each next one
 *   after pi settles, after the recorded pause (capped). A steer is sent while the tools of the
 *   message before it run.
 * - Progress events go to `<control>/events.jsonl`. When an event reaches the `until` stop, every
 *   wait in the replay holds from then on, so the screen stops changing except for pi-ui's own
 *   timers.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deltas, planMessage } from "./pacing.ts";
import {
  type AssistantStep,
  buildScript,
  nextAssistant,
  type PromptStep,
  parseSession,
  promptBefore,
  responseIdOf,
  RESPONSE_PREFIX,
  type Script,
  steerAfter,
  type ToolCallRef,
} from "./session.ts";
import { formatStop, parseStop, reached, type ReplayEvent, type Stop } from "./stops.ts";

export interface ReplayConfig {
  /** The recorded session file. Read only. */
  session: string;
  /** 2 plays twice as fast. */
  speed: number;
  /** The longest pause between prompts, after scaling. */
  maxGapMs: number;
  /** The longest single wait of any kind, after scaling; none when absent. */
  maxWaitMs?: number;
  startTurn?: number;
  until?: string;
  theme?: string;
  /** A directory for `events.jsonl`, and the `go` file the driver creates when it watches. */
  control?: string;
}

export const PROVIDER = "replay";
export const BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** pi compacts when a request nears the context window; recorded usage must never trigger it. */
const CONTEXT_WINDOW = 100_000_000;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Pi {
  registerProvider(name: string, config: Record<string, unknown>): void;
  registerTool(definition: Record<string, unknown>): void;
  sendUserMessage(content: unknown, options?: { deliverAs?: "steer" | "followUp" }): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}

type Partial = Record<string, unknown> & { content: Array<Record<string, unknown>> };
type ArgumentsParser = { append(chunk: string): Record<string, unknown> };

/** The replay's state and its waits. Kept apart from pi so the provider stream can be tested. */
export class Replay {
  readonly script: Script;
  readonly stop: Stop | undefined;
  private paused = false;
  private release: Promise<void> = Promise.resolve();
  private readonly emittedErrors = new Set<number>();
  private readonly sent = new Set<PromptStep>();
  private readonly started = performance.now();
  turn = 0;

  constructor(
    readonly config: ReplayConfig,
    script?: Script,
    private readonly write: (line: string) => void = () => {},
  ) {
    this.script =
      script ?? buildScript(parseSession(readFileSync(config.session, "utf8")), { startTurn: config.startTurn });
    this.stop = config.until ? parseStop(config.until) : undefined;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Reports `event`; reaching the stop pauses every later wait. */
  report(event: ReplayEvent, log = true): void {
    if (log) this.write(JSON.stringify({ t: Math.round(performance.now() - this.started), ...event }));
    if (!this.paused && this.stop && reached(this.stop, event)) {
      this.paused = true;
      this.release = new Promise<void>(() => {});
      this.write(
        JSON.stringify({
          t: Math.round(performance.now() - this.started),
          type: "paused",
          stop: formatStop(this.stop),
        }),
      );
    }
  }

  /** A recorded wait, scaled and capped; holds while paused. */
  async wait(recordedMs: number, capMs = this.config.maxWaitMs): Promise<void> {
    const ms = Math.min(recordedMs / this.config.speed, capMs ?? Number.POSITIVE_INFINITY);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    while (this.paused) await this.release;
  }

  /** The next prompt to send after pi settles, or undefined when the script is done. */
  nextPrompt(): PromptStep | undefined {
    return this.script.steps.find(
      (step): step is PromptStep => step.kind === "prompt" && step.live && !this.sent.has(step),
    );
  }

  markSent(prompt: PromptStep): void {
    this.sent.add(prompt);
    if (!prompt.steer) this.turn = prompt.turn;
  }

  /**
   * The events of one assistant response to a request with `messages`. With nothing left to say,
   * or when the next message's prompt has not been sent yet, the response is empty.
   */
  async *respond(
    messages: ReadonlyArray<{ role?: string; responseId?: unknown }>,
    model: string,
    options: { signal?: AbortSignal; parser?: () => ArgumentsParser; onDone?: (step: AssistantStep) => void } = {},
  ): AsyncGenerator<Record<string, unknown>> {
    const step = nextAssistant(this.script, messages, this.emittedErrors);
    const prompt = step && promptBefore(this.script, step);
    const base = { role: "assistant", api: PROVIDER, provider: PROVIDER, timestamp: Date.now() };
    if (!step || (prompt?.live && !this.sent.has(prompt))) {
      if (!step) this.report({ type: "warning", text: "a request after the last recorded message" });
      const empty = { ...base, model, usage: ZERO_USAGE, stopReason: "stop", content: [] };
      yield { type: "start", partial: { ...empty } };
      yield { type: "done", reason: "stop", message: empty };
      return;
    }
    const recorded = step.message;
    const stopReason = recorded.stopReason ?? "stop";
    if (stopReason === "error") this.emittedErrors.add(step.index);
    const final = {
      ...base,
      model: recorded.model ?? model,
      usage: recorded.usage ?? ZERO_USAGE,
      responseId: responseIdOf(step.index),
      stopReason,
      ...(recorded.errorMessage ? { errorMessage: recorded.errorMessage } : {}),
      content: structuredClone(step.blocks),
    };
    const partial: Partial = { ...final, content: [], stopReason: "pending" };
    const plan = planMessage(recorded, step.durationMs);
    const aborted = () => ({ ...partial, stopReason: "aborted", errorMessage: "Operation aborted" });

    this.report({ type: "message_start", message: step.index, turn: step.turn });
    yield { type: "start", partial: { ...partial } };
    await this.wait(plan.latencyMs);
    let streamed = 0;
    let reportedTenth = 0;
    for (const block of plan.blocks) {
      const source = step.blocks[block.index]!;
      const index = partial.content.length;
      const kind = block.kind === "toolCall" ? "toolcall" : block.kind;
      if (block.kind === "thinking") partial.content.push({ ...source, thinking: "" });
      else if (block.kind === "text") partial.content.push({ ...source, text: "" });
      else partial.content.push({ ...source, arguments: {} });
      yield { type: `${kind}_start`, contentIndex: index, partial: { ...partial } };
      const parser = block.kind === "toolCall" ? options.parser?.() : undefined;
      const pieces = deltas(block);
      if (!pieces.length) await this.wait(block.durationMs);
      for (const piece of pieces) {
        await this.wait(piece.delayMs);
        if (options.signal?.aborted) {
          yield { type: "error", reason: "aborted", error: aborted() };
          return;
        }
        const target = partial.content[index]!;
        if (block.kind === "thinking") target.thinking = `${target.thinking}${piece.text}`;
        else if (block.kind === "text") target.text = `${target.text}${piece.text}`;
        else if (parser) target.arguments = parser.append(piece.text);
        yield { type: `${kind}_delta`, contentIndex: index, delta: piece.text, partial: { ...partial } };
        streamed += piece.text.length;
        const pct = plan.chars ? Math.min(100, (100 * streamed) / plan.chars) : 100;
        const tenth = Math.floor(pct / 10);
        // Every delta is checked against the stop; the log keeps one line per tenth.
        this.report(
          { type: "progress", message: step.index, pct, block: block.index, kind: block.kind },
          tenth > reportedTenth,
        );
        reportedTenth = Math.max(reportedTenth, tenth);
      }
      partial.content[index] = source;
      if (block.kind === "toolCall")
        yield { type: "toolcall_end", contentIndex: index, toolCall: source, partial: { ...partial } };
      else yield { type: `${kind}_end`, contentIndex: index, content: block.text, partial: { ...partial } };
    }
    this.report({ type: "message_end", message: step.index, stopReason });
    options.onDone?.(step);
    if (stopReason === "error" || stopReason === "aborted") yield { type: "error", reason: stopReason, error: final };
    else yield { type: "done", reason: stopReason, message: final };
  }

  /** The recorded call behind a tool call id. */
  call(id: string): ToolCallRef | undefined {
    return this.script.tools.find((call) => call.id === id);
  }

  /** Runs a replayed tool: the recorded wait, a shell command's output line by line, the recorded result. */
  async execute(
    id: string,
    name: string,
    onUpdate?: (partial: { content: unknown[]; details: unknown }) => void,
  ): Promise<{ content: unknown[]; details: unknown }> {
    const call = this.call(id);
    const result = call?.result;
    this.report({ type: "tool_start", tool: call?.index ?? 0, id, name });
    await this.wait(0);
    if (!result) return { content: [{ type: "text", text: `replay: no recorded result for ${id}` }], details: {} };
    const duration = result.durationMs ?? 0;
    const text = result.content.map((part: any) => (part?.type === "text" ? part.text : "")).join("");
    const lines = SHELL_TOOLS.has(name) && onUpdate ? text.split("\n") : [];
    if (lines.length > 1) {
      const updates = Math.min(lines.length, Math.max(1, Math.round(duration / this.config.speed / 80)));
      for (let step = 1; step <= updates; step++) {
        await this.wait(duration / updates);
        const shown = lines.slice(0, Math.round((lines.length * step) / updates)).join("\n");
        if (step < updates) onUpdate?.({ content: [{ type: "text", text: shown }], details: {} });
      }
    } else {
      await this.wait(duration);
    }
    return { content: result.content, details: result.details ?? {} };
  }
}

function readConfig(): ReplayConfig {
  const path = process.env.PI_REPLAY_CONFIG;
  if (!path) throw new Error("replay: PI_REPLAY_CONFIG is not set");
  return JSON.parse(readFileSync(path, "utf8")) as ReplayConfig;
}

export default function replayExtension(pi: Pi): void {
  const config = readConfig();
  const events = config.control ? join(config.control, "events.jsonl") : undefined;
  const replay = new Replay(config, undefined, (line) => {
    if (events) appendFileSync(events, `${line}\n`);
  });
  const { script } = replay;
  let parser: (() => ArgumentsParser) | undefined;
  // pi maps this import to its own copy; outside pi (tests, tsgo) it does not resolve, and tool
  // call arguments then appear whole at the end of each call instead of growing.
  // @ts-expect-error -- resolved by pi at runtime only
  import("@earendil-works/pi-ai")
    .then((ai: any) => {
      if (typeof ai.ToolCallArgumentsStream === "function") parser = () => new ai.ToolCallArgumentsStream();
    })
    .catch(() => {});

  const models = script.models.length ? script.models : ["replay"];
  pi.registerProvider(PROVIDER, {
    name: PROVIDER,
    // Never contacted: the stream answers in process. Port 9 is closed, so nothing could leave anyway.
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "replay",
    api: PROVIDER,
    streamSimple: (
      model: { id: string },
      context: { messages: Array<{ role?: string; responseId?: unknown }> },
      options?: { signal?: AbortSignal },
    ) =>
      replay.respond(context.messages, model.id, {
        signal: options?.signal,
        parser: parser && (() => parser!()),
        onDone: (step) => {
          const steer = steerAfter(script, step);
          if (!steer || !steer.live) return;
          replay.markSent(steer);
          replay.report({ type: "prompt", turn: steer.turn, steer: true });
          setTimeout(() => pi.sendUserMessage(steer.content, { deliverAs: "steer" }), 0);
        },
      }),
    models: models.map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW,
      maxTokens: 128_000,
    })),
  });

  for (const name of new Set([...BUILTIN_TOOLS, ...script.toolNames])) {
    pi.registerTool({
      name,
      label: name,
      description: `Replays the recorded results of ${name}.`,
      parameters: { type: "object", additionalProperties: true },
      execute: (
        id: string,
        _params: unknown,
        _signal: unknown,
        onUpdate?: (partial: { content: unknown[]; details: unknown }) => void,
      ) => replay.execute(id, name, onUpdate),
    });
  }

  // After pi-ui's handlers: the recorded result stands, whatever pi-ui measured in this cwd.
  pi.on("tool_result", (event: { toolCallId: string }) => {
    const result = replay.call(event.toolCallId)?.result;
    if (!result) return { isError: true };
    return { content: result.content, details: result.details ?? {}, isError: result.isError };
  });
  pi.on("tool_execution_end", (event: { toolCallId: string; toolName: string; isError?: boolean }) => {
    const call = replay.call(event.toolCallId);
    replay.report({
      type: "tool_end",
      tool: call?.index ?? 0,
      id: event.toolCallId,
      name: event.toolName,
      isError: !!event.isError,
    });
  });
  // Recorded timings and usage replace the ones measured at replay speed.
  pi.on("message_end", (event: { message: Record<string, unknown> }) => {
    const message = event.message;
    if (message.role === "toolResult") {
      const result = replay.call(String(message.toolCallId))?.result;
      return result?.durationMs === undefined ? undefined : { message: { ...message, durationMs: result.durationMs } };
    }
    const id = message.role === "assistant" ? message.responseId : undefined;
    if (typeof id !== "string" || !id.startsWith(RESPONSE_PREFIX)) return undefined;
    const step = script.steps.find(
      (candidate) => candidate.kind === "assistant" && responseIdOf(candidate.index) === id,
    );
    if (step?.kind !== "assistant") return undefined;
    const recorded = Object.fromEntries(
      Object.entries(step.message).filter(([key]) => key.startsWith("piUi") || key.startsWith("prism")),
    );
    return { message: { ...message, ...recorded, durationMs: step.durationMs } };
  });

  const sendNext = async (): Promise<void> => {
    const prompt = replay.nextPrompt();
    if (!prompt) {
      replay.report({ type: "finished" });
      return;
    }
    await replay.wait(prompt.gapMs, config.maxGapMs);
    replay.markSent(prompt);
    replay.report({ type: "prompt", turn: prompt.turn, steer: prompt.steer });
    pi.sendUserMessage(prompt.content);
  };

  pi.on(
    "session_start",
    (
      _event: unknown,
      ctx: { ui?: { getTheme?(name: string): object | undefined; setTheme?(theme: object): unknown } },
    ) => {
      // A Theme instance is not saved to settings.
      const theme = ctx.ui?.getTheme?.(config.theme ?? "dark");
      if (theme) ctx.ui?.setTheme?.(theme);
      replay.report({ type: "ready" });
      // Not awaited: pi finishes starting while the driver gets ready to watch.
      void (async () => {
        if (config.control)
          while (!existsSync(join(config.control, "go"))) await new Promise((resolve) => setTimeout(resolve, 50));
        await sendNext();
      })();
    },
  );
  pi.on("agent_settled", () => {
    replay.report({ type: "settled", turn: replay.turn });
    void sendNext();
  });
}
