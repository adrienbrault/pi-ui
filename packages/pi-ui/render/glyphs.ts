/** Glyph sets. ASCII is the accessibility floor; every card must render in all three. */

export interface GlyphSet {
  pending: string;
  success: string;
  error: string;
  collapsed: string;
  expanded: string;
  thinking: string;
  dot: string;
  /** An omission notice's side: its hidden lines are above it, below it, or between the rows around it. */
  above: string;
  below: string;
  between: string;
  spinner: readonly string[];
}

export const UNICODE_GLYPHS: GlyphSet = {
  pending: "○",
  success: "●",
  error: "✗",
  collapsed: "▸",
  expanded: "▾",
  thinking: "✻",
  dot: "·",
  above: "↑",
  below: "↓",
  between: "⋮",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const ASCII_GLYPHS: GlyphSet = {
  pending: "o",
  success: "*",
  error: "x",
  collapsed: ">",
  expanded: "v",
  thinking: "~",
  dot: ".",
  above: "^",
  below: "v",
  between: ":",
  spinner: ["-", "\\", "|", "/"],
};

export const NERD_GLYPHS: GlyphSet = {
  pending: "○",
  success: "●",
  error: "✗",
  collapsed: "",
  expanded: "",
  thinking: "",
  dot: "·",
  above: "↑",
  below: "↓",
  between: "⋮",
  spinner: ["󰪚", "󰪛", "󰪜", "󰪝"],
};

export type GlyphMode = "unicode" | "ascii" | "nerd";

export function glyphsFor(mode: GlyphMode): GlyphSet {
  if (mode === "ascii") return ASCII_GLYPHS;
  if (mode === "nerd") return NERD_GLYPHS;
  return UNICODE_GLYPHS;
}

export function frameAt(glyphs: GlyphSet, frame = 0): string {
  const length = glyphs.spinner.length;
  if (length === 0) return "";
  const index = ((frame % length) + length) % length;
  return glyphs.spinner[index] ?? "";
}
