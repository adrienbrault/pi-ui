/**
 * Tool row: one header line plus a bounded body. The body budget is the whole
 * point: the closer a row is to the tail, the more of its output survives.
 */

import { bodyLinesFor, type DetailLevel } from "./detail.ts";
import { frameAt, type GlyphSet } from "./glyphs.ts";
import type { ComponentLike, RenderKit, RenderTheme } from "./kit.ts";
import { logicalLines, nonEmptyLineCount } from "./text.ts";
import { describeCall, summarizeOutput, toolMeta } from "./tools.ts";

export interface RenderApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
}

export type ToolStatus = "pending" | "running" | "success" | "error";

export interface ToolRowInput {
  name: string;
  args?: Record<string, unknown>;
  status: ToolStatus;
  level: DetailLevel;
  expanded?: boolean;
  /** Read the whole body: no budget, no "more lines" cue. */
  full?: boolean;
  /** Override the derived path/command/query. */
  title?: string;
  /** Override the derived count, e.g. "42 lines" or "+8/−2". */
  summary?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  frame?: number;
}

const INDENT = "  ";
/** Opening a block twice is meant to end the hunt: past this, the log wins. */
const MAX_FULL_LINES = 400;

/** Diff lines keep their meaning under decay: additions green, removals red. */
function diffTone(line: string, cls: string): "success" | "error" | "accent" | "dim" | undefined {
  if (cls !== "edit" && cls !== "write") return undefined;
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return "dim";
  }
  if (line.startsWith("@@")) return "accent";
  if (line.startsWith("+")) return "success";
  if (line.startsWith("-")) return "error";
  return undefined;
}

function statusGlyph(api: RenderApi, input: ToolRowInput): string {
  const { theme, glyphs } = api;
  switch (input.status) {
    case "pending":
      return theme.fg("dim", glyphs.pending);
    case "running":
      return theme.fg("accent", frameAt(glyphs, input.frame ?? 0) || glyphs.pending);
    case "success":
      return theme.fg("success", glyphs.success);
    case "error":
      return theme.fg("error", glyphs.error);
  }
}

/** Keep the end of a long path: the basename is the part a reader needs. */
function truncateLeft(kit: RenderKit, text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (kit.visibleWidth(text) <= width) return text;
  const chars = [...text];
  let kept = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const candidate = (chars[i] ?? "") + kept;
    if (kit.visibleWidth(candidate) + kit.visibleWidth(ellipsis) > width) break;
    kept = candidate;
  }
  return kept ? `${ellipsis}${kept}` : kit.truncateToWidth(text, width, ellipsis);
}

type HeaderPiece = { kind: "title" | "summary" | "error" | "duration"; text: string };

function durationLabel(input: ToolRowInput, theme: RenderTheme): string | undefined {
  if (input.durationMs === undefined) return undefined;
  const seconds = input.durationMs / 1000;
  const label = seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  return theme.fg("dim", label);
}

function header(api: RenderApi, input: ToolRowInput, width: number): string {
  const { theme, glyphs, kit } = api;
  const meta = toolMeta(input.name);
  const title = input.title ?? describeCall(input.name, input.args).title;
  const summary = input.summary ?? (input.status === "success" ? summarizeOutput(input.output ?? "") : "");

  const sep = ` ${theme.fg("dim", glyphs.dot)} `;
  const prefix = `${statusGlyph(api, input)} ${theme.bold(theme.fg("toolTitle", meta.label))}`;

  let pieces: HeaderPiece[] = [];
  // MCP labels already read `server/tool`; repeating it as the title is noise.
  if (title && title !== meta.label) pieces.push({ kind: "title", text: theme.fg("accent", title) });
  if (summary) pieces.push({ kind: "summary", text: theme.fg("dim", summary) });
  if (input.status === "error" && input.error) pieces.push({ kind: "error", text: theme.fg("error", input.error) });
  const duration = durationLabel(input, theme);
  if (duration) pieces.push({ kind: "duration", text: duration });

  const compose = (parts: HeaderPiece[]) => parts.reduce((acc, part) => `${acc}${sep}${part.text}`, prefix);

  // Narrow terminals: shed decoration before substance. Duration goes first, then
  // the summary; an error is never dropped, and a long title keeps its basename.
  for (const kind of ["duration", "summary"] as const) {
    if (kit.visibleWidth(compose(pieces)) <= width) break;
    pieces = pieces.filter((piece) => piece.kind !== kind);
  }

  if (kit.visibleWidth(compose(pieces)) > width) {
    const titlePiece = pieces.find((piece) => piece.kind === "title");
    if (titlePiece) {
      const others = pieces.filter((piece) => piece !== titlePiece);
      const room = width - kit.visibleWidth(compose(others)) - kit.visibleWidth(sep);
      titlePiece.text = theme.fg("accent", truncateLeft(kit, title, room));
    }
  }

  return kit.truncateToWidth(compose(pieces), width, "…");
}

interface Selected {
  line: string;
  /** A notice row rather than a body row. */
  notice?: boolean;
}

/** Diff metadata and unchanged context are the first rows to go. */
const DIFF_NOISE = /^(diff --git|index |new file|deleted file|similarity |rename |--- |\+\+\+ )/;
const isDiffContext = (line: string): boolean => DIFF_NOISE.test(line) || line.startsWith(" ");

const notice = (text: string): Selected => ({ line: `< ${text} >`, notice: true });

/**
 * Diffs keep what changed. Before hiding any hunk, drop the unchanged context
 * lines: the +/- rows carry the evidence, context is what a reader can infer.
 */
function selectDiff(lines: string[], show: number): Selected[] {
  if (lines.length <= show) return lines.map((line) => ({ line }));

  const essential = lines.filter((line) => !isDiffContext(line));
  const contextHidden = lines.length - essential.length;
  if (essential.length + 1 <= show) {
    return [...essential.map((line) => ({ line })), notice(`${contextHidden} context lines hidden`)];
  }

  // Still too long: read the evidence in order, and say how much is left.
  const kept = show - 1;
  const hidden = essential.length - kept;
  return [...essential.slice(0, kept).map((line) => ({ line })), notice(`${hidden} more lines`)];
}

/** Reads keep their opening and their end; the middle is usually boilerplate. */
function selectHead(lines: string[], show: number): Selected[] {
  if (lines.length <= show) return lines.map((line) => ({ line }));
  const room = show - 1;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  const hidden = lines.length - head - tail;
  return [
    ...lines.slice(0, head).map((line) => ({ line })),
    notice(`${hidden} more lines`),
    ...lines.slice(-tail).map((line) => ({ line })),
  ];
}

/** Logs keep the end: the last line is the one that explains the run. */
function selectTail(lines: string[], show: number): Selected[] {
  if (lines.length <= show) return lines.map((line) => ({ line }));
  // The newest line always survives: one row of budget is never spent on a notice.
  if (show <= 1) return lines.slice(-1).map((line) => ({ line }));
  const kept = show - 1;
  return [notice(`${lines.length - kept} earlier lines`), ...lines.slice(-kept).map((line) => ({ line }))];
}

const DIFF_HINT = /^(diff --git|@@ )/m;

function select(text: string, name: string, trend: "head" | "tail", show: number): Selected[] {
  const lines = logicalLines(text).filter((line) => line.trim() !== "");
  const cls = toolMeta(name).cls;
  if ((cls === "edit" || cls === "write") && DIFF_HINT.test(text)) return selectDiff(lines, show);
  return trend === "tail" ? selectTail(lines, show) : selectHead(lines, show);
}

function body(api: RenderApi, input: ToolRowInput, width: number): string[] {
  const { theme, kit } = api;
  // A "full" read is allowed to be long, just not unbounded.
  const budget = input.full ? MAX_FULL_LINES : bodyLinesFor(input.level, input.expanded ?? false);
  if (budget <= 0) return [];

  const text = input.error || input.output || "";
  const present = nonEmptyLineCount(text);
  if (present === 0) return [];

  const meta = toolMeta(input.name);
  // A notice counts against the budget: total body rows never exceed it.
  const show = Math.min(budget, present);
  const selected = select(text, input.name, meta.trend, show);

  return selected.map(({ line, notice: isNotice }) => {
    const content = kit.truncateToWidth(line, Math.max(1, width - INDENT.length), "…");
    if (isNotice) return INDENT + theme.fg("dim", content);
    const tone = diffTone(line, meta.cls);
    return INDENT + (tone ? theme.fg(tone, content) : theme.fg("toolOutput", content));
  });
}

export function renderToolRow(api: RenderApi, input: ToolRowInput): ComponentLike {
  return api.kit.component((width) => {
    return [header(api, input, width), ...body(api, input, width)];
  });
}

/** One collapsed row, no body: the aged 3 form. */
export function renderToolLine(api: RenderApi, input: ToolRowInput): ComponentLike {
  return api.kit.component((width) => [header(api, input, width)]);
}
