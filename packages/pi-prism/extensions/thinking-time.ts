import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimatedTokens } from "../render/tools.ts";

interface Span {
  start: number;
  end?: number;
  firstDelta?: number;
  lastDelta?: number;
  subsequentChars: number;
}

const live = new WeakMap<object, Map<number, Span>>();

export interface TimedMessage {
  durationMs?: number;
  /** Elapsed milliseconds by the first content index of each visible thinking run. */
  prismThinkingMs?: Record<number, number>;
  prismThinkingRates?: Record<number, number>;
}

function sampledRate(span: Span): number | undefined {
  if (span.firstDelta === undefined || span.lastDelta === undefined || span.lastDelta <= span.firstDelta)
    return undefined;
  return (1000 * estimatedTokens(span.subsequentChars)) / (span.lastDelta - span.firstDelta);
}

export function thinkingTime(message: TimedMessage, first: number, streaming: boolean) {
  const span = streaming ? live.get(message)?.get(first) : undefined;
  if (span)
    return {
      durationMs: (span.end ?? performance.now()) - span.start,
      running: span.end === undefined,
      outputRate: sampledRate(span) ?? null,
    };
  const elapsed = message.prismThinkingMs?.[first];
  return {
    durationMs: elapsed ?? (streaming ? undefined : message.durationMs),
    turnDuration: !streaming && elapsed === undefined,
    running: false,
    outputRate: message.prismThinkingRates ? (message.prismThinkingRates[first] ?? null) : undefined,
  };
}

export function installThinkingClock(pi: ExtensionAPI, repaint: () => void): void {
  let spans = new Map<number, Span>();
  const active = new Map<number, Span>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function finish(index: number): void {
    const span = active.get(index);
    if (!span) return;
    active.delete(index);
    if (![...active.values()].includes(span)) span.end = span.lastDelta ?? performance.now();
    if (active.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function reset(): void {
    for (const index of active.keys()) finish(index);
    spans = new Map();
  }

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("message_start", ({ message }) => {
    if (message.role === "assistant") reset();
  });
  pi.on("message_update", ({ message, assistantMessageEvent: event }, ctx) => {
    if (message.role !== "assistant" || ctx.mode !== "tui") return;
    if (event.type === "thinking_start") {
      let first = event.contentIndex;
      while (message.content[first - 1]?.type === "thinking") first--;
      const span = spans.get(first) ?? { start: performance.now(), subsequentChars: 0 };
      span.end = undefined;
      spans.set(first, span);
      active.set(event.contentIndex, span);
      timer ??= setInterval(repaint, 100);
    } else if (event.type === "thinking_delta" && event.delta) {
      const span = active.get(event.contentIndex);
      if (span) {
        const now = performance.now();
        if (span.firstDelta === undefined) span.firstDelta = now;
        else span.subsequentChars += event.delta.length;
        span.lastDelta = now;
      }
    } else if (event.type === "thinking_end") {
      finish(event.contentIndex);
    }
    if (spans.size) live.set(message, spans);
  });
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant" || !spans.size) return;
    for (const index of active.keys()) finish(index);
    const prismThinkingMs: Record<number, number> = {};
    const prismThinkingRates: Record<number, number> = {};
    for (const [index, span] of spans) {
      prismThinkingMs[index] = Math.round(span.end! - span.start);
      const rate = sampledRate(span);
      if (rate !== undefined) prismThinkingRates[index] = rate;
    }
    reset();
    const timed = { ...message, prismThinkingMs, prismThinkingRates };
    return { message: timed };
  });
}
