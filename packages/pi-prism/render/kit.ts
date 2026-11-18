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
  /** Visible terminal columns, not string length. */
  visibleWidth(text: string): number;
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

export function indented(prefix: string, text: string, width: number, kit: RenderKit): string {
  const budget = Math.max(1, width - prefix.length);
  return prefix + kit.truncateToWidth(text, budget, "…");
}

export function padBetween(left: string, right: string, width: number, theme: RenderTheme, kit: RenderKit): string {
  const gap = Math.max(0, width - kit.visibleWidth(left) - kit.visibleWidth(right));
  return left + theme.fg("dim", " ".repeat(gap)) + right;
}
