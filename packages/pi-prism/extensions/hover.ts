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
