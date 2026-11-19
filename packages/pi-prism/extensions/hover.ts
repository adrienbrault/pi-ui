import { visibleWidth } from "@earendil-works/pi-tui";
import { cleanOutput } from "../render/text.ts";

export function isOmissionRow(line: string): boolean {
  return /^\+ \d+ lines?$/.test(cleanOutput(line).trim());
}

/** Paint the measured terminal row, restoring its background after nested styles end. */
export function highlightGroupRow(
  rows: string[],
  row: number | undefined,
  width: number,
  background: string,
): string[] {
  if (row === undefined || rows[row] === undefined || !background) return rows;
  const line = rows[row]!;
  // oxlint-disable-next-line no-control-regex -- pi emits SGR resets after styled spans
  const painted = line.replace(/\x1b\[(?:0|49|22;39;49|39;49)m/g, (reset) => reset + background);
  rows[row] = background + painted + " ".repeat(Math.max(0, width - visibleWidth(line))) + "\x1b[49m";
  return rows;
}

/**
 * One hovered surface at a time.
 *
 * Terminals report continuous motion, so a per-row latch leaves every row the
 * pointer crossed lit at once. Claiming a new owner clears the previous one
 * before its chip can paint.
 */

let owner: object | undefined;
let clear: (() => void) | undefined;

/** Make `next` the only lit surface, clearing whoever held the hover before. */
export function claimHover(next: object, clearNext: () => void): void {
  if (owner && owner !== next) clear?.();
  owner = next;
  clear = clearNext;
}

/** Stop tracking a surface once its own hover timer expires. */
export function releaseHover(next: object): void {
  if (owner !== next) return;
  owner = undefined;
  clear = undefined;
}

/** Moving onto an inert row clears the previous actionable surface. */
export function clearHover(): boolean {
  const previous = clear;
  owner = undefined;
  clear = undefined;
  previous?.();
  return previous !== undefined;
}

/** A spacer owns its terminal row for pointing, while wheel and drag events pass through. */
export function onSpacerMouse(event: { type?: string }) {
  if (event.type === "move" || event.type === "click") return { handled: true, render: clearHover() } as const;
  return undefined;
}
