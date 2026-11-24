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
  /**
   * Before a token count: what the model was sent (input) and what it returned (output), as pi's
   * footer writes them (`↑3.5k ↓467`). ASCII keeps the words, since `^` and `v` mark notices.
   */
  input: string;
  output: string;
  spinner: readonly string[];
  /** A finished todo: a check; ASCII writes `x`, as a checklist's `[x]` does. */
  done: string;
  /** A todo panel's progress bar: a filled cell and an empty one. */
  barFill: string;
  barEmpty: string;
}

/** What token numbers are written with: the two marks and the separator dot. */
export type TokenMarks = Pick<GlyphSet, "input" | "output" | "dot">;

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
  input: "↑",
  output: "↓",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  done: "✓",
  barFill: "▰",
  barEmpty: "▱",
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
  input: "in ",
  output: "out ",
  spinner: ["-", "\\", "|", "/"],
  done: "x",
  barFill: "#",
  barEmpty: "-",
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
  input: "↑",
  output: "↓",
  spinner: ["󰪚", "󰪛", "󰪜", "󰪝"],
  done: "✓",
  barFill: "█",
  barEmpty: "░",
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
