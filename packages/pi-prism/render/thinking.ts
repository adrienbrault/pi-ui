/**
 * Thinking label.
 *
 * The extension can only hand pi a string for hidden thinking blocks, so the
 * design surface here *is* a label: multi-line, width-clipped, with the marker
 * on the first row and continuation rows indented under it. That keeps the
 * gallery honest about what can actually ship.
 */

import { bodyLinesFor, COMPACT_LEVEL, MAX_FULL_LINES, type DetailLevel } from "./detail.ts";
import { frameAt, type GlyphSet } from "./glyphs.ts";
import { blockBodyIndent, cutMark, type RenderKit, type RenderTheme } from "./kit.ts";
import { previewBar, truncateMiddle, type BarCell } from "./tool-row.ts";
import { estimatedTokens, formatRate } from "./tools.ts";
import {
  cleanOutput,
  cleanThinking,
  formatDuration,
  logicalLines,
  omittedLinesLabel,
  MAX_FORMAT_CHARS,
} from "./text.ts";

export interface ThinkingApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
  owner?: object;
}

export type ThinkingPhase = "thinking" | "done" | "aged";

export interface ThinkingLabelInput {
  phase: ThinkingPhase;
  level: DetailLevel;
  text: string;
  width: number;
  frame?: number;
  durationMs?: number;
  turnDuration?: boolean;
  /** null when the stream has too few timed deltas for a rate. */
  outputRate?: number | null;
  reasoningTokens?: number;
  estimatedTokens?: number;
  expanded?: boolean;
  /**
   * Streaming previews clamp each source line to the terminal width instead of
   * wrapping it, so arriving tokens extend the last row instead of reflowing the
   * whole tail. Defaults to `phase === "thinking"`; expansion always wraps.
   */
  truncate?: boolean;
}

const MARKER = "think";

function clampLine(api: ThinkingApi, line: string, width: number): string {
  return api.kit.truncateToWidth(line, Math.max(1, width), cutMark(api.theme));
}

interface Header {
  indent: string;
  bodyWidth: number;
  source: string[];
  formatted: string[] | undefined;
  last: string;
  /** Every source line on one line, in plain text. */
  flat: string;
  marker: string;
  dot: string;
  metrics: string;
  heading: (left: string) => string;
}

function headerFor(api: ThinkingApi, input: ThinkingLabelInput): Header {
  const { kit, theme, glyphs } = api;
  const indent = blockBodyIndent(input.width);
  const bodyWidth = Math.max(1, input.width - indent.length);
  // Streaming truncation is a preview-only rule; opening the block wraps.
  const truncate = !input.expanded && (input.truncate ?? input.phase === "thinking");
  // Plain thoughts keep their inexpensive logical-line tail. Parse Markdown before selecting
  // rows, so an excerpt in the middle of a list or a fenced block keeps its formatting.
  const markup = /[`*_#>|~[\\$<]|^ {0,3}(?:[-+=]|\d+[.)])(?:\s|$)|^ {4}|^\t|^[-=]{3,}$/m;
  const formatted =
    !truncate && kit.markdown && input.text.length <= MAX_FORMAT_CHARS && markup.test(input.text)
      ? kit.markdown(cleanOutput(input.text), bodyWidth, theme, api.owner).map((row) => row.trimEnd())
      : undefined;
  const source = formatted?.length ? formatted : logicalLines(cleanThinking(input.text));
  const plain = (line: string) => (formatted ? cleanOutput(line) : line).trim();
  const last = source.findLast((line) => plain(line)) ?? "";
  // The whole thought on one line, as the reader sees it: rendered Markdown, no markup.
  const flat = source.map(plain).filter(Boolean).join(" ");
  const glyph = input.phase === "thinking" ? frameAt(glyphs, input.frame ?? 0) : glyphs.thinking;
  const marker = `${theme.fg("accent", glyph)} ${theme.style(MARKER, { fg: "toolTitle", bold: true })}`;
  const dot = theme.fg("dim", glyphs.dot);
  const count = input.reasoningTokens ?? input.estimatedTokens ?? estimatedTokens(input.text.length);
  const tokens = `${count} token${count === 1 ? "" : "s"}`;
  const duration = input.durationMs === undefined ? undefined : formatDuration(input.durationMs);
  const timing = duration ? ` ${dot} ${theme.fg("dim", duration + (input.turnDuration ? " turn" : ""))}` : "";
  const rate =
    input.outputRate === undefined &&
    input.phase !== "thinking" &&
    !input.turnDuration &&
    input.durationMs &&
    input.durationMs > 0
      ? (count * 1000) / input.durationMs
      : input.outputRate;
  const speed = rate ? ` ${formatRate(rate)}/s` : "";
  const metrics = theme.fg("dim", tokens + speed) + timing;
  const heading = (left: string) => {
    const prefix = left + ` ${dot} `;
    const gap = Math.max(0, input.width - kit.visibleWidth(prefix + metrics));
    return clampLine(api, prefix + " ".repeat(gap) + metrics, input.width);
  };
  return { indent, bodyWidth, source, formatted, last, flat, marker, dot, metrics, heading };
}

/**
 * The unstyled plan for one label: header data plus every terminal body row the
 * current source can show, oldest first. Callers select the window; the
 * extension uses the same plan to stagger rows out one at a time.
 */
export interface ThinkingFrame {
  head: string;
  /** Styled terminal rows, before the collapsed tail window. */
  rows: string[];
  /** Source line index for each terminal row. */
  sources: number[];
  sourceCount: number;
  /** Terminal rows the collapsed budget shows. */
  keep: number;
  canToggle: boolean;
  indent: string;
  last: string;
  /** The whole thought on one line, in plain text. */
  flat: string;
  formatted: boolean;
  marker: string;
  dot: string;
  metrics: string;
  heading: (left: string) => string;
}

/** Rows a collapsed budget gives a thought's body: at least four, less one for the notice. */
function collapsedBudget(level: DetailLevel): number {
  const budget = bodyLinesFor(level);
  return Math.min(budget, Math.max(4, budget - 1));
}

/** Terminal rows of a thought's body that a level keeps: the newest ones. */
export function thinkingKeep(level: DetailLevel): number {
  return Math.max(1, collapsedBudget(level) - 1);
}

export function thinkingFrame(
  api: ThinkingApi,
  input: ThinkingLabelInput,
  streamingRows?: (total: number, keep: number) => number[],
): ThinkingFrame {
  const header = headerFor(api, input);
  const truncate = !input.expanded && (input.truncate ?? input.phase === "thinking");
  const keep = thinkingKeep(input.level);
  const candidateStart = input.expanded
    ? 0
    : Math.max(0, header.source.length - (truncate ? keep : Math.max(16, keep)));
  const indices =
    truncate && streamingRows
      ? streamingRows(header.source.length, keep)
      : Array.from({ length: header.source.length - candidateStart }, (_, i) => candidateStart + i);
  const terminal = indices.flatMap((source) => {
    const line = header.source[source]!;
    const texts = truncate
      ? [clampLine(api, line, header.bodyWidth)]
      : header.formatted
        ? [line]
        : api.kit.wrap(line, header.bodyWidth);
    return texts.map((text) => ({ text, source }));
  });
  const rows = terminal.map(({ text }) =>
    header.formatted ? header.indent + text : api.theme.italic(api.theme.fg("thinkingText", header.indent + text)),
  );
  const clamped = truncate && indices.some((i) => api.kit.visibleWidth(header.source[i]!) > header.bodyWidth);
  const canToggle = header.source.length > indices.length || terminal.length > keep || clamped;
  return {
    head: header.heading(header.marker),
    rows,
    sources: terminal.map(({ source }) => source),
    sourceCount: header.source.length,
    keep,
    canToggle,
    indent: header.indent,
    last: header.last,
    flat: header.flat,
    formatted: !!header.formatted,
    marker: header.marker,
    dot: header.dot,
    metrics: header.metrics,
    heading: header.heading,
  };
}

export interface ThinkingLayout {
  label: string;
  canToggle: boolean;
  /**
   * For a collapsed preview with a body: where its rows sit in the whole
   * thought, one cell per body row (every label row after the heading,
   * including the omission notice). Each cell stands for an equal share of the
   * source lines and is filled where the preview shows some of them.
   */
  bar?: BarCell[];
}

/**
 * Compose the header, selected body rows and omission notice within the current budget.
 */
export function composeThinkingLabel(
  api: ThinkingApi,
  input: ThinkingLabelInput,
  frame: ThinkingFrame,
): ThinkingLayout {
  const { kit, theme } = api;
  const notice = (hidden: number) => theme.fg("dim", `${frame.indent}${omittedLinesLabel(hidden)}`);

  if (bodyLinesFor(input.level) <= 1 && !input.expanded) {
    // One row: the start and the end of the reasoning, cut in the middle like a command.
    const prefix = `${frame.marker} ${frame.dot} `;
    const room = input.width - kit.visibleWidth(frame.metrics) - 3 - kit.visibleWidth(prefix);
    const excerpt = frame.flat
      ? truncateMiddle(kit, frame.flat, Math.max(0, room), cutMark(theme), (part) => theme.fg("thinkingText", part))
      : undefined;
    return {
      label: frame.heading(excerpt?.text ? prefix + excerpt.text : frame.marker),
      canToggle: !!excerpt?.cut,
    };
  }

  if (input.expanded) {
    // Match tool output's safety cap. Keep both ends in order and count the notice in the budget.
    const rows =
      frame.rows.length <= MAX_FULL_LINES
        ? frame.rows
        : [
            ...frame.rows.slice(0, MAX_FULL_LINES - 2),
            frame.rows[frame.rows.length - 1]!,
            notice(frame.rows.length - (MAX_FULL_LINES - 1)),
          ];
    return {
      label: [frame.head, ...rows].map((row) => clampLine(api, row, input.width)).join("\n"),
      canToggle: thinkingLayout(api, { ...input, expanded: false }).canToggle,
    };
  }

  const from = Math.max(0, frame.rows.length - frame.keep);
  const visible = frame.rows.slice(from, from + frame.keep);
  const visibleSources = new Set(frame.sources.slice(from, from + frame.keep));
  const hidden = frame.sourceCount - visibleSources.size;
  const rows = [...visible];
  const omitted = hidden || frame.rows.length - visible.length;
  if (collapsedBudget(input.level) > 1 && frame.canToggle && omitted > 0) {
    if (input.phase === "thinking") rows.unshift(notice(omitted));
    else rows.push(notice(omitted));
  }
  return {
    label: [frame.head, ...rows].map((row) => clampLine(api, row, input.width)).join("\n"),
    canToggle: frame.canToggle,
    bar: previewBar(frame.sourceCount, visibleSources, rows.length),
  };
}

export function thinkingLabel(api: ThinkingApi, input: ThinkingLabelInput): string {
  return thinkingLayout(api, input).label;
}

/** Report whether toggling reveals text at this width, including clipped inline previews. */
export function thinkingLayout(api: ThinkingApi, input: ThinkingLabelInput): ThinkingLayout {
  return composeThinkingLabel(api, input, thinkingFrame(api, input));
}

/**
 * The label row the next level drops, for a settled thought: its oldest kept
 * row, under the heading. Undefined when the next level keeps the same rows,
 * as levels whose collapsed budgets floor at four do.
 */
export function thinkingLeavingRow(api: ThinkingApi, input: ThinkingLabelInput): number | undefined {
  if (input.expanded || bodyLinesFor(input.level) <= 1) return undefined;
  const rows = thinkingFrame(api, input).rows.length;
  const next = Math.min(input.level + 1, COMPACT_LEVEL) as DetailLevel;
  if (bodyLinesFor(next) <= 1) return 1;
  return Math.min(rows, thinkingKeep(input.level)) > Math.min(rows, thinkingKeep(next)) ? 1 : undefined;
}
