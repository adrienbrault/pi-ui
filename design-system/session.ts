/**
 * One scripted coding-agent session, expanded into playback frames. Both lanes
 * replay the same frames, so a difference on screen is a rendering difference,
 * never a content difference.
 */

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
  | { kind: "tool"; label: string; tool: SessionTool };

const BASH = "bash";

export const SESSION_STEPS: SessionStep[] = [
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
      summary: "10 lines",
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
      summary: "181 lines",
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
  // Output arrives line by line, not in one batch.
  for (let lines = 1; lines <= outputLines; lines++) {
    frames.push({
      step,
      label: `${label} · output ${lines}/${outputLines}`,
      chars: title.length,
      lines,
      partial: true,
      ms: OUTPUT_LINE_MS,
    });
  }
  frames.push({ step, label, chars: title.length, lines: outputLines, partial: false, ms: OUTPUT_LINE_MS });
  return frames;
}

function framesForStep(step: SessionStep, index: number): PlaybackFrame[] {
  switch (step.kind) {
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
