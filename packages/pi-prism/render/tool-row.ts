/**
 * Tool row: one header line plus a bounded body. The body budget is the whole
 * point: the closer a row is to the tail, the more of its output survives.
 */

import { bodyLinesFor, type DetailLevel } from "./detail.ts";
import { frameAt, type GlyphSet } from "./glyphs.ts";
import type { ComponentLike, RenderKit, RenderTheme } from "./kit.ts";
import { headLines, nonEmptyLineCount, tailLines } from "./text.ts";
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

function body(api: RenderApi, input: ToolRowInput, width: number): string[] {
  const { theme, kit } = api;
  const budget = bodyLinesFor(input.level, input.expanded ?? false);
  if (budget <= 0) return [];

  const text = input.error || input.output || "";
  const present = nonEmptyLineCount(text);
  if (present === 0) return [];

  const expanded = input.expanded ?? false;
  // Expanded views cap their *total* body rows: the notice takes one of them.
  const show = expanded && present > budget ? budget - 1 : Math.min(budget, present);

  const meta = toolMeta(input.name);
  const source = meta.trend === "tail" ? tailLines(text, show) : headLines(text, show);

  const rows = source.map((line) => {
    const content = kit.truncateToWidth(line, Math.max(1, width - INDENT.length), "…");
    const tone = diffTone(line, meta.cls);
    return INDENT + (tone ? theme.fg(tone, content) : theme.fg("toolOutput", content));
  });

  if (expanded && present > show) {
    const hidden = present - show;
    const note = kit.truncateToWidth(`… ${hidden} more line${hidden === 1 ? "" : "s"}`, width, "…");
    rows.push(INDENT + theme.fg("dim", note));
  }

  return rows;
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
