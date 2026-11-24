/**
 * The viewer's frame: an image's rows centred in the room left under the caption, in both axes.
 * The caption above it stays put, so only the image moves as the numbers change.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * `rows` centred in `height` rows and `width` columns. A row keeps its own left padding, measured
 * without its escapes, so an image of any shape sits in the middle of the terminal. An image too
 * tall or too wide for the room keeps its top-left corner where it is: the terminal cuts it.
 */
export function centerImage(rows: string[], width: number, height: number): string[] {
  const top = Math.max(0, Math.floor((height - rows.length) / 2));
  const centered = rows.map((row) => " ".repeat(Math.max(0, Math.floor((width - visibleWidth(row)) / 2))) + row);
  return [...Array.from({ length: top }, () => ""), ...centered];
}
