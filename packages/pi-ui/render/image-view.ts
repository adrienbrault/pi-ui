/**
 * The viewer's frame: an image's rows centred in the room left under the caption, in both axes.
 * The caption above it stays put, so only the image moves as the numbers change.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** The cells a graphics row draws over, as named by the escape that carries it: kitty `c=`, iTerm2 `width=`. */
export function imageColumns(row: string): number | undefined {
  if (row.includes("\x1b_G")) {
    const named = /c=(\d+)/.exec(row);
    if (named) return Number(named[1]);
  }
  if (row.includes("\x1b]1337;File=")) {
    const named = /width=(\d+)/.exec(row);
    if (named) return Number(named[1]);
  }
  return undefined;
}

/**
 * `rows` centred in `height` rows and `width` columns. An image's width comes from its own escape,
 * because the sequence that draws it counts as no column at all; a row of text is measured by what
 * it prints. An image too tall or too wide for the room keeps its top-left corner where it is: the
 * terminal cuts it.
 */
export function centerImage(rows: string[], width: number, height: number): string[] {
  const drawn = rows.map(imageColumns).find((columns) => columns !== undefined);
  const columns = drawn ?? Math.max(0, ...rows.map((row) => visibleWidth(row)));
  const left = " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
  const top = Math.max(0, Math.floor((height - rows.length) / 2));
  const centered = rows.map((row) => left + row);
  return [...Array.from({ length: top }, () => ""), ...centered];
}
