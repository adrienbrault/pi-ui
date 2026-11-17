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
  const indent = " ".repeat(kit.visibleWidth(marker) + 1);

  // One-line form: aged L3 and anything past it.
  if (input.level >= 3 && !(input.expanded ?? false)) {
    const label = input.phase === "thinking" ? `${marker} ${frameAt(glyphs, input.frame ?? 0)}` : marker;
    const suffix = last ? ` ${glyphs.dot} ${last}` : "";
    return clampLine(kit, `${label}${suffix}`, input.width);
  }

  const budget = input.expanded ? 16 : bodyLinesFor(input.level);
  const spinner = input.phase === "thinking" ? ` ${frameAt(glyphs, input.frame ?? 0)}` : "";
  const head = `${marker}${spinner} ${seconds(input.durationMs)}`.trimEnd();

  const rows = tail.slice(-budget).map((line, index) => (index === 0 ? `${head} ${line}` : `${indent}${line}`));
  if (rows.length === 0) return clampLine(kit, head, input.width);
  return rows.map((row) => clampLine(kit, row, input.width)).join("\n");
}
