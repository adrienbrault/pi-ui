/**
 * How long each part of a recorded assistant message takes to stream again.
 *
 * A message's recorded `durationMs` runs from the request to the last event. Each block gets a
 * streaming time, the rest of the duration is the wait before the first delta:
 * - a thinking block takes its recorded thinking time (`piUiThinkingMs`, or `prismThinkingMs` in
 *   older sessions), else its size at its recorded thinking rate;
 * - a tool call takes its argument size at the rate pi-ui recorded for that call (`piUiThroughput`);
 * - any other block, or one without a recording, takes its size at the median recorded rate, or
 *   when no rate was recorded, they share what is left of three quarters of the duration.
 * Recorded rates are estimates from delta timing and can be far off, so when the blocks add up to
 * more than the duration, they shrink together to fit it and the first delta comes at once.
 *
 * Sizes are in estimated tokens: four characters each, as pi-ui estimates them.
 *
 * Pure: no I/O, no timers.
 */

import type { ContentBlock, RecordedMessage } from "./session.ts";

export interface BlockPlan {
  index: number;
  kind: "thinking" | "text" | "toolCall";
  /** What streams: thinking or text, or the tool call's arguments as JSON. */
  text: string;
  durationMs: number;
}

export interface MessagePlan {
  /** Before the first delta. */
  latencyMs: number;
  blocks: BlockPlan[];
  /** Characters across blocks: the denominator of a stream's progress. */
  chars: number;
}

export interface Delta {
  /** After the previous delta of the same block, or after the block starts. */
  delayMs: number;
  text: string;
}

const STREAM_SHARE = 0.75;

const tokens = (chars: number): number => Math.ceil(chars / 4);

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function indexed(value: unknown): Record<string, number> {
  return value && typeof value === "object" ? (value as Record<string, number>) : {};
}

export function blockText(block: ContentBlock): string {
  if (block.type === "thinking") return block.thinking ?? "";
  if (block.type === "text") return block.text ?? "";
  if (block.type === "toolCall") return JSON.stringify(block.arguments ?? {});
  return "";
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function planMessage(message: RecordedMessage, durationMs: number): MessagePlan {
  const thinkingMs = indexed(message.piUiThinkingMs ?? message.prismThinkingMs);
  const thinkingRates = indexed(message.piUiThinkingRates ?? message.prismThinkingRates);
  const throughput = (message.piUiThroughput ?? message.prismThroughput) as
    | { output?: Array<{ id?: string; rate?: number }> }
    | undefined;
  const callRates = new Map<string, number>();
  for (const call of throughput?.output ?? []) {
    const rate = positive(call.rate);
    if (call.id && rate) callRates.set(call.id, rate);
  }

  const content = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
  const blocks = content.flatMap((block, index) =>
    block.type === "thinking" || block.type === "text" || block.type === "toolCall"
      ? [{ index, kind: block.type, text: blockText(block), block }]
      : [],
  );
  const recordedRates = [
    ...callRates.values(),
    ...Object.values(thinkingRates).flatMap((rate) => positive(rate) ?? []),
  ];
  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);

  const recorded = blocks.map(({ index, kind, text, block }) => {
    const size = tokens(text.length);
    if (kind === "thinking") {
      const rate = positive(thinkingRates[index]);
      return positive(thinkingMs[index]) ?? (rate ? (1000 * size) / rate : undefined);
    }
    const rate = kind === "toolCall" && block.id ? callRates.get(block.id) : undefined;
    return rate ? (1000 * size) / rate : undefined;
  });
  const unknownTokens = blocks.reduce(
    (sum, block, i) => sum + (recorded[i] === undefined ? tokens(block.text.length) : 0),
    0,
  );
  const knownMs = recorded.reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
  const fallbackRate =
    median(recordedRates) ??
    (unknownTokens > 0 ? unknownTokens / (Math.max(0, durationMs * STREAM_SHARE - knownMs) / 1000) : undefined);
  const timed = blocks.map(({ index, kind, text }, i) => {
    const size = tokens(text.length);
    const fallback = fallbackRate && Number.isFinite(fallbackRate) && size ? (1000 * size) / fallbackRate : 0;
    return { index, kind: kind as BlockPlan["kind"], text, durationMs: recorded[i] ?? fallback };
  });

  const streaming = timed.reduce((sum, block) => sum + block.durationMs, 0);
  const scale = streaming > durationMs ? durationMs / streaming : 1;
  const planned = timed.map((block) => ({ ...block, durationMs: Math.round(block.durationMs * scale) }));
  const latencyMs = Math.max(0, Math.round(durationMs - streaming * scale));
  return { latencyMs, blocks: planned, chars };
}

/**
 * A block's text as deltas spread evenly over its duration, one every `tickMs` or so; at least
 * one code point per delta, so a short block streams in fewer, longer steps.
 */
export function deltas(block: BlockPlan, tickMs = 40): Delta[] {
  // Code points, so a delta never splits a surrogate pair.
  const chars = [...block.text];
  const { durationMs } = block;
  if (!chars.length) return [];
  const count = Math.max(1, Math.min(chars.length, Math.round(durationMs / tickMs)));
  const result: Delta[] = [];
  let taken = 0;
  for (let step = 1; step <= count; step++) {
    const end = Math.round((chars.length * step) / count);
    result.push({ delayMs: durationMs / count, text: chars.slice(taken, end).join("") });
    taken = end;
  }
  return result;
}
