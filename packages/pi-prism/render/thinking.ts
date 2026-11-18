/**
 * Thinking label.
 *
 * The extension can only hand pi a string for hidden thinking blocks, so the
 * design surface here *is* a label: multi-line, width-clipped, with the marker
 * on the first row and continuation rows indented under it. That keeps the
 * gallery honest about what can actually ship.
 */

import { bodyLinesFor, type DetailLevel } from "./detail.ts";
import { frameAt, type GlyphSet } from "./glyphs.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";
import { cleanThinking, nonEmptyLineCount, squeeze, tailLines } from "./text.ts";

export interface ThinkingApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
}

export type ThinkingPhase = "thinking" | "done" | "aged";

export interface ThinkingLabelInput {
  phase: ThinkingPhase;
  level: DetailLevel;
  text: string;
  width: number;
  frame?: number;
  durationMs?: number;
  expanded?: boolean;
}

const MARKER = "think";

/** Body rows share the tool-row indent so blocks line up down the left edge. */
const INDENT = "  ";

function seconds(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  const value = durationMs / 1000;
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}

function clampLine(kit: RenderKit, line: string, width: number): string {
  return kit.truncateToWidth(line, Math.max(1, width), "…");
}

export function thinkingLabel(api: ThinkingApi, input: ThinkingLabelInput): string {
  const { kit, theme, glyphs } = api;
  const cleaned = cleanThinking(input.text);
  const tail = tailLines(cleaned, 16);
  const last = squeeze(tail.at(-1) ?? "");

  // The marker reads like a tool status glyph: coloured, never grey. While text
  // is still arriving it is the thing that spins — no second indicator needed.
  // The title uses the same token as every other header, so it stays full contrast.
  const glyph = input.phase === "thinking" ? frameAt(glyphs, input.frame ?? 0) : glyphs.thinking;
  const marker = `${theme.fg("accent", glyph)} ${theme.style(MARKER, { fg: "toolTitle", bold: true })}`;
  const dot = theme.fg("dim", glyphs.dot);
  const body = (row: string) => theme.italic(theme.fg("thinkingText", INDENT + row));

  // One-line form: only at the floor, so the ladder sheds a row at a time.
  if (input.level >= 6 && !(input.expanded ?? false)) {
    const suffix = last ? ` ${dot} ${theme.fg("thinkingText", last)}` : "";
    return clampLine(kit, `${marker}${suffix}`, input.width);
  }

  const budget = Math.max(1, input.expanded ? 16 : bodyLinesFor(input.level));
  const duration = seconds(input.durationMs);
  const head = duration ? `${marker} ${theme.fg("dim", duration)}` : marker;

  // One row of the budget is the header. Body text wraps instead of ending in
  // an ellipsis: a terminal row is a layout unit, not a truncation point.
  const bodyWidth = Math.max(1, input.width - INDENT.length);
  const wrapped = tail.flatMap((row, source) => kit.wrap(row, bodyWidth).map((line) => ({ line, source })));
  const bodyBudget = Math.max(0, budget - 1);
  let rows: string[];
  if (input.expanded) {
    // Expanded rows show the whole thought (already capped to the last 16
    // source lines above).
    rows = wrapped.slice(-bodyBudget).map((row) => body(row.line));
  } else if (bodyBudget <= 1) {
    // One body row is never spent on a notice: the newest line itself wins.
    rows = wrapped.slice(-1).map((row) => body(row.line));
  } else {
    const visible = wrapped.slice(-(bodyBudget - 1));
    const shownSources = new Set(visible.map((row) => row.source)).size;
    const hidden = nonEmptyLineCount(cleaned) - shownSources;
    rows = [];
    if (hidden > 0) rows.push(theme.fg("dim", `${INDENT}< ${hidden} more lines >`));
    rows.push(...visible.map((row) => body(row.line)));
  }
  return [head, ...rows].map((row) => clampLine(kit, row, input.width)).join("\n");
}
