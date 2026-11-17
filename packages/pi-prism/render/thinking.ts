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
import { cleanThinking, squeeze, tailLines } from "./text.ts";

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

function seconds(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  const value = durationMs / 1000;
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}

function clampLine(kit: RenderKit, line: string, width: number): string {
  return kit.truncateToWidth(line, Math.max(1, width), "…");
}

export function thinkingLabel(api: ThinkingApi, input: ThinkingLabelInput): string {
  const { kit, glyphs } = api;
  const cleaned = cleanThinking(input.text);
  const tail = tailLines(cleaned, 16);
  const last = squeeze(tail.at(-1) ?? "");

  const marker = `${glyphs.thinking} ${MARKER}`;

  // Body rows sit flush left like every other block: the marker is a header,
  // not a hanging indent.

  // One-line form: only at the floor, so the ladder sheds a row at a time.
  if (input.level >= 6 && !(input.expanded ?? false)) {
    const label = input.phase === "thinking" ? `${marker} ${frameAt(glyphs, input.frame ?? 0)}` : marker;
    const suffix = last ? ` ${glyphs.dot} ${last}` : "";
    return clampLine(kit, `${label}${suffix}`, input.width);
  }

  const budget = Math.max(1, input.expanded ? 16 : bodyLinesFor(input.level));
  const spinner = input.phase === "thinking" ? ` ${frameAt(glyphs, input.frame ?? 0)}` : "";
  const head = `${marker}${spinner} ${seconds(input.durationMs)}`.trimEnd();

  // One row of the budget is the header; the rest is tail, unindented.
  const rows = tail.slice(-(budget - 1));
  return [head, ...rows].map((row) => clampLine(kit, row, input.width)).join("\n");
}
