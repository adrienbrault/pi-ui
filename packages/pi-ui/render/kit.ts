/**
 * RenderKit: the only terminal primitives a renderer needs, injected so the
 * module stays dependency-free. The extension passes pi-tui's helpers; the
 * design system passes the helpers from the pi install it renders against.
 */

export interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
}

export interface RenderKit {
  /** ANSI-aware truncation with an ellipsis. */
  truncateToWidth(line: string, width: number, ellipsis?: string): string;
  /** ANSI-aware word wrapping; returns one terminal row per line. */
  wrap(text: string, width: number): string[];
  /** Visible terminal columns, not string length. */
  visibleWidth(text: string): number;
  languageFromPath?(path: string): string | undefined;
  highlight?(source: string, language: string, theme: RenderTheme, owner?: object): string[];
  markdown?(source: string, width: number, theme: RenderTheme, owner?: object): string[];
  /** Wrap a width-dependent line builder as a pi-tui Component. */
  component(build: (width: number) => string[]): ComponentLike;
}

/** A theme surface wide enough for every token we use. pi's Theme satisfies it. */
export interface RenderTheme {
  fg(token: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  /** pi's Theme.style: colours and weight in one pass, sans chalk. */
  style(text: string, options: { fg?: string; bg?: string; bold?: boolean }): string;
  /** Resolved palette, when the theme exposes it (pi's Theme does). */
  colors?: Record<string, string>;
}

/**
 * The mark where text was cut, in the middle, at either end or between an
 * excerpt and its heading: a bold ellipsis in the text colour with a space each
 * side, so a cut reads as a cut and never as part of a word. Three columns wide.
 */
export function cutMark(theme: RenderTheme): string {
  return theme.style(" … ", { fg: "text", bold: true });
}

/**
 * An omission notice's style: italic `thinkingOff`, the faintest text grey pi's
 * themes define (below `dim`: okhsl 49% vs 56% in dark, 80% vs 59% in light).
 * It recedes behind the output and stays clear of the `accent` used by commands
 * and headings; the italic and the direction glyph set it apart. `lit` while
 * the pointer is over a block that can open or close: the notice's words turn
 * the bright text colour, with no background, saying what a click reveals.
 */
export function omissionStyle(theme: RenderTheme, label: string, lit = false): string {
  return theme.italic(theme.fg(lit ? "text" : "thinkingOff", label));
}

/** Body text starts one two-column step past the heading label, leaving room for content on narrow screens. */
export function blockBodyIndent(width: number): string {
  return "    ".slice(0, Math.max(0, width - 1));
}
