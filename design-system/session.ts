/**
 * One scripted coding-agent session, expanded into playback frames. Both lanes
 * replay the same frames, so a difference on screen is a rendering difference,
 * never a content difference.
 */

import { formatDuration } from "../packages/pi-prism/render/text.ts";
import {
  ASSISTANT_SOURCE,
  DETAIL_DIFF,
  EDIT_DIFF,
  FINAL_TEXT,
  GREP_OUTPUT,
  MCP_OUTPUT,
  SESSION_CODE,
  SESSION_THINKING,
  SESSION_THINKING_2,
  TEST_FAIL,
  SESSION_NOTE_1,
  SESSION_NOTE_2,
  SESSION_NOTE_3,
  TEST_OK,
  editPath,
} from "./fixtures-data.ts";

export interface SessionTool {
  name: string;
  args: Record<string, unknown>;
  /** Display overrides; the base lane derives its own from args. */
  title?: string;
  summary?: string;
  output?: string;
  durationMs?: number;
  failed?: boolean;
}

export type SessionStep =
  | { kind: "user" | "thinking" | "text"; label: string; text: string }
  | { kind: "tool"; label: string; tool: SessionTool }
  /** Context the model ingests before it can answer; it draws nothing. */
  | { kind: "prefill"; label: string; tokens: number };

const BASH = "bash";

/** Repeated turns reuse the fixtures: same evidence, different moment in the session. */
const readStep = (label: string, title: string, output: string, durationMs: number): SessionStep => ({
  kind: "tool",
  label,
  tool: { name: "read", args: { path: title }, title, output, durationMs },
});
const grepStep = (label: string, pattern: string, summary: string): SessionStep => ({
  kind: "tool",
  label,
  tool: {
    name: "grep",
    args: { pattern },
    title: pattern,
    summary,
    output: GREP_OUTPUT,
    durationMs: 90,
  },
});
const editStep = (label: string, path: string, summary: string): SessionStep => ({
  kind: "tool",
  label,
  tool: { name: "edit", args: { path }, title: path, summary, output: EDIT_DIFF, durationMs: 300 },
});
const bashStep = (
  label: string,
  command: string,
  summary: string,
  output: string,
  durationMs: number,
  failed = false,
): SessionStep => ({
  kind: "tool",
  label,
  tool: { name: BASH, args: { command }, title: command, summary, output, durationMs, failed },
});

export const SESSION_VIEWPORT_ROWS = 35;

export const SESSION_STEPS: SessionStep[] = [
  { kind: "prefill", label: "prefill", tokens: 12_400 },
  {
    kind: "user",
    label: "prompt",
    text: "Make long sessions readable: keep the live detail, fold the rest.",
  },
  { kind: "thinking", label: "thinking", text: SESSION_THINKING },
  {
    kind: "tool",
    label: "read session.ts",
    tool: {
      name: "read",
      args: { path: "src/core/session.ts" },
      title: "src/core/session.ts",
      output: SESSION_CODE,
      durationMs: 180,
    },
  },
  {
    kind: "tool",
    label: "read assistant-message.js",
    tool: {
      name: "read",
      args: { path: "src/modes/interactive/components/assistant-message.js" },
      title: "src/modes/interactive/components/assistant-message.js",
      output: ASSISTANT_SOURCE,
      durationMs: 240,
    },
  },
  {
    kind: "tool",
    label: "search registerToolRenderer",
    tool: {
      name: "grep",
      args: { pattern: "registerToolRenderer" },
      title: "registerToolRenderer",
      summary: "3 matches",
      output: GREP_OUTPUT,
      durationMs: 90,
    },
  },
  { kind: "text", label: "note 1/3", text: SESSION_NOTE_1 },
  {
    kind: "tool",
    label: "edit decorator.ts",
    tool: {
      name: "edit",
      args: { path: editPath },
      title: editPath,
      summary: "+42 −7",
      output: EDIT_DIFF,
      durationMs: 320,
    },
  },
  { kind: "text", label: "note 2/3", text: SESSION_NOTE_2 },
  {
    kind: "tool",
    label: "bun test fails",
    tool: {
      name: BASH,
      args: { command: "bun test" },
      title: "bun test",
      summary: "1 failed",
      output: TEST_FAIL,
      durationMs: 5400,
      failed: true,
    },
  },
  { kind: "thinking", label: "thinking", text: SESSION_THINKING_2 },
  {
    kind: "tool",
    label: "edit detail.ts",
    tool: {
      name: "edit",
      args: { path: "packages/pi-prism/render/detail.ts" },
      title: "packages/pi-prism/render/detail.ts",
      summary: "+6 −2",
      output: DETAIL_DIFF,
      durationMs: 260,
    },
  },
  {
    kind: "tool",
    label: "bun test passes",
    tool: {
      name: BASH,
      args: { command: "bun test" },
      title: "bun test",
      summary: "28 passing",
      output: TEST_OK,
      durationMs: 8700,
    },
  },
  { kind: "text", label: "note 3/3", text: SESSION_NOTE_3 },
  {
    kind: "tool",
    label: "memory search",
    tool: {
      name: "mcp__memory__search",
      args: { query: "decay ladder" },
      title: "memory/search",
      summary: "2 entries",
      output: MCP_OUTPUT,
      durationMs: 70,
    },
  },
  { kind: "thinking", label: "thinking", text: SESSION_THINKING },
  readStep("read registry.ts", "src/core/registry.ts", SESSION_CODE, 160),
  {
    kind: "thinking",
    label: "thinking",
    text: "Registry is the seam: read, grep, edit all pass through one resolver.",
  },
  grepStep("search planTranscript", "planTranscript", "21 matches"),
  { kind: "text", label: "note 4/10", text: "The planner is the seam: it owns order, the renderers own rows." },
  editStep("edit layout.ts", "packages/pi-prism/render/layout.ts", "+42 −7"),
  { kind: "thinking", label: "thinking", text: "Planner before renderers: order first, then rows." },
  bashStep("check fails", "bun run check", "1 failed", TEST_FAIL, 3200, true),
  { kind: "text", label: "note 5/10", text: "One failing expectation: the fold distance moved without the ladder." },
  { kind: "thinking", label: "thinking", text: SESSION_THINKING_2 },
  readStep("read DESIGN.md", "DESIGN.md", ASSISTANT_SOURCE, 240),
  grepStep("search settleLevel", "settleLevel", "21 matches"),
  editStep("edit thinking.ts", "packages/pi-prism/render/thinking.ts", "+6 −2"),
  { kind: "thinking", label: "thinking", text: "Hysteresis settles one level, so a click pins until the turn ends." },
  { kind: "text", label: "note 6/10", text: "Hysteresis belongs in the level, not the caller: one settle point." },
  bashStep("lint", "bun run lint", "28 passing", TEST_OK, 1800),
  { kind: "thinking", label: "thinking", text: SESSION_THINKING },
  readStep("read group-row.ts", "packages/pi-prism/render/group-row.ts", SESSION_CODE, 170),
  grepStep("search FOLD_DISTANCE", "FOLD_DISTANCE", "21 matches"),
  editStep("edit registry.ts", "design-system/registry.ts", "+42 −7"),
  { kind: "thinking", label: "thinking", text: "The summary counts failed commands alongside the total." },
  {
    kind: "text",
    label: "note 7/10",
    text: "Group rows carry their members: counts, order and failures survive folding.",
  },
  bashStep("test", "bun test", "28 passing", TEST_OK, 5400),
  { kind: "thinking", label: "thinking", text: SESSION_THINKING_2 },
  readStep("read build.ts", "design-system/build.ts", ASSISTANT_SOURCE, 260),
  grepStep("search POOL_FRAME_THRESHOLD", "POOL_FRAME_THRESHOLD", "21 matches"),
  editStep("edit html.ts", "design-system/html.ts", "+6 −2"),
  { kind: "thinking", label: "thinking", text: "Pool frames by content: repetition is what makes the page heavy." },
  {
    kind: "text",
    label: "note 8/10",
    text: "Frames stay pooled; the reveal composes over the collapsed body in place.",
  },
  bashStep("ds", "bun run ds", "28 passing", TEST_OK, 2100),
  { kind: "thinking", label: "thinking", text: SESSION_THINKING },
  readStep("read tools.ts", "packages/pi-prism/render/tools.ts", SESSION_CODE, 150),
  editStep("edit group-row.ts", "packages/pi-prism/render/group-row.ts", "+42 −7"),
  { kind: "thinking", label: "thinking", text: "Clicks and hovers share one state; inert rows stay silent." },
  bashStep("check", "bun run check", "28 passing", TEST_OK, 8700),
  {
    kind: "text",
    label: "note 9/10",
    text: "Green again. One deliberate stop: the head of the session must stay readable at the floor.",
  },
  { kind: "thinking", label: "thinking", text: SESSION_THINKING_2 },
  readStep("read interaction.test.ts", "packages/pi-prism/extensions/interaction.test.ts", ASSISTANT_SOURCE, 230),
  grepStep("search MouseRegion", "MouseRegion", "21 matches"),
  bashStep("test suite", "bun test", "28 passing", TEST_OK, 4300),
  { kind: "text", label: "note 10/10", text: "Clicks and hovers are covered; inert rows deliberately offer nothing." },
  {
    kind: "tool",
    label: "memory search",
    tool: {
      name: "mcp__memory__search",
      args: { query: "tail budget" },
      title: "memory/search",
      summary: "2 entries",
      output: MCP_OUTPUT,
      durationMs: 70,
    },
  },
  { kind: "text", label: "answer", text: FINAL_TEXT },
];

/** A single frame of the replay: how far each stream has progressed. */
export interface PlaybackFrame {
  /** Index into SESSION_STEPS. */
  step: number;
  /** Caption for the step indicator. */
  label: string;
  /** Characters of prose, thinking or a tool title revealed so far. */
  chars: number;
  /** Output lines revealed so far. */
  lines: number;
  /** Still streaming: spinner and running status. */
  partial: boolean;
  /** Elapsed time within the current tool or thinking step. */
  elapsedMs?: number;
  /** How long this frame is on screen, in ms, at 100 tokens/second. */
  ms: number;
}

/**
 * Streaming is chunked, not batched: sizes vary the way tokens arrive, so the
 * tail visibly grows instead of jumping a line at a time. One chunk is about one
 * token, and at 100 tok/s a token frame costs 10ms.
 */
const TOKEN_MS = 10;
const OUTPUT_LINE_MS = 10;
/** Prefill is not generation: prompt context lands at thousands of tokens a second. */
const PREFILL_TOKENS_PER_SECOND = 4000;
/** A tool that takes seconds should look like it: the timer keeps moving. */
const WAIT_FRAME_MS = 80;
const CHUNK_SIZES = [3, 5, 4, 7, 2, 6, 3, 4] as const;

function chunkEnds(length: number): number[] {
  const ends: number[] = [];
  let at = 0;
  for (let i = 0; at < length; i++) {
    at = Math.min(length, at + (CHUNK_SIZES[i % CHUNK_SIZES.length] ?? 4));
    ends.push(at);
  }
  return ends;
}

function thinkingFrames(step: number, label: string, text: string): PlaybackFrame[] {
  const ends = chunkEnds(text.length);
  return [
    ...ends.map((chars, index) => ({
      step,
      elapsedMs: (index + 1) * TOKEN_MS,
      label: `${label} · thinking ${Math.round(((index + 1) / ends.length) * 100)}%`,
      chars,
      lines: 0,
      partial: true,
      ms: TOKEN_MS,
    })),
    { step, label, chars: text.length, lines: 0, partial: false, ms: TOKEN_MS },
  ];
}

function textFrames(step: number, label: string, text: string): PlaybackFrame[] {
  const ends = chunkEnds(text.length);
  return ends.map((chars, index) => ({
    step,
    label: index < ends.length - 1 ? `${label} · streaming` : label,
    chars,
    lines: 0,
    partial: index < ends.length - 1,
    ms: TOKEN_MS,
  }));
}

function toolFrames(step: number, label: string, tool: SessionTool): PlaybackFrame[] {
  const title = tool.title ?? "";
  const outputLines = (tool.output ?? "").split("\n").length;
  const frames: PlaybackFrame[] = [];
  // Arguments arrive character by character: the path or command is composed live.
  for (const chars of chunkEnds(title.length)) {
    frames.push({ step, label: `${label} · call`, chars, lines: 0, partial: true, ms: TOKEN_MS });
  }
  // A tool that ran for seconds spends those seconds on screen before output.
  if (tool.durationMs && tool.durationMs >= 1000) {
    frames.push(...waitFrames(step, label, title, tool.durationMs));
  }
  // Output arrives line by line, not in one batch.
  for (let lines = 1; lines <= outputLines; lines++) {
    frames.push({
      step,
      label: `${label} · output ${lines}/${outputLines}`,
      chars: title.length,
      lines,
      partial: true,
      elapsedMs: tool.durationMs,
      ms: OUTPUT_LINE_MS,
    });
  }
  frames.push({ step, label, chars: title.length, lines: outputLines, partial: false, ms: OUTPUT_LINE_MS });
  return frames;
}

function prefillFrames(step: number, label: string, tokens: number): PlaybackFrame[] {
  const totalMs = (tokens / PREFILL_TOKENS_PER_SECOND) * 1000;
  const parts = Math.max(1, Math.round(totalMs / WAIT_FRAME_MS));
  return Array.from({ length: parts }, (_, index) => ({
    step,
    label: `${label} · ${Math.round(((index + 1) / parts) * tokens).toLocaleString("en-US")} tok · ${PREFILL_TOKENS_PER_SECOND} tok/s`,
    chars: 0,
    lines: 0,
    partial: false,
    ms: totalMs / parts,
  }));
}

function waitFrames(step: number, label: string, title: string, durationMs: number): PlaybackFrame[] {
  const parts = Math.max(1, Math.round(durationMs / WAIT_FRAME_MS));
  return Array.from({ length: parts }, (_, index) => ({
    step,
    label: `${label} · waiting ${formatDuration((index + 1) * (durationMs / parts))}`,
    // The call is already parsed; only the result is missing while it runs.
    chars: title.length,
    lines: 0,
    partial: true,
    elapsedMs: ((index + 1) * durationMs) / parts,
    ms: durationMs / parts,
  }));
}

function framesForStep(step: SessionStep, index: number): PlaybackFrame[] {
  switch (step.kind) {
    case "prefill":
      return prefillFrames(index, step.label, step.tokens);
    case "user":
      return [{ step: index, label: step.label, chars: step.text.length, lines: 0, partial: false, ms: TOKEN_MS }];
    case "thinking":
      return thinkingFrames(index, step.label, step.text);
    case "text":
      return textFrames(index, step.label, step.text);
    case "tool":
      return toolFrames(index, step.label, step.tool);
  }
}

export const PLAYBACK: PlaybackFrame[] = SESSION_STEPS.flatMap((step, index) => framesForStep(step, index));

// Steps play sequentially. Include the simulated time spent streaming thoughts and arguments.
const stepEnds: number[] = [];
let playbackTime = 0;
for (const frame of PLAYBACK) {
  playbackTime += frame.ms;
  stepEnds[frame.step] = playbackTime;
}

export function playbackGroupDuration(indices: number[]): number | undefined {
  const first = indices[0];
  const last = indices.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return stepEnds[last]! - (stepEnds[first - 1] ?? 0);
}

/** One caption per playback frame, so the scrubber reads like a trace. */
export const FRAME_LABELS: string[] = PLAYBACK.map((frame) => frame.label);

export function stepAt(frame: PlaybackFrame): SessionStep {
  const step = SESSION_STEPS[frame.step];
  if (!step) throw new Error(`playback frame ${frame.step} has no step`);
  return step;
}

/** The same slices drive both lanes, so neither invents content. */
export function partialText(text: string, chars: number): string {
  return text.slice(0, Math.max(0, chars));
}

export function partialLines(text: string, lines: number): string {
  return text.split("\n").slice(0, Math.max(0, lines)).join("\n");
}

/**
 * The argument that streams for this tool: pi shows the path or command grow as
 * the call is composed, so the replay does the same.
 */
export function streamingArgKey(name: string): string {
  if (name === "bash" || name === "powershell") return "command";
  if (name === "grep" || name === "find" || name === "ffgrep" || name === "fffind") return "pattern";
  return "path";
}
