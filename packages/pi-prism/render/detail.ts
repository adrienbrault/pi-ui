/**
 * The decay model: how much detail a transcript block earns, by how far it sits
 * from the tail of the current run.
 *
 * Kept dependency-free so the design system and the extension share one source
 * of truth. Recompute on structural events only; never per stream token.
 */

/** 0 = live, 4 = folded into a group summary. */
export type DetailLevel = 0 | 1 | 2 | 3 | 4;

/** Bodies under the header, per level. Total height = 1 + body lines. */
export const BODY_LINES: Record<DetailLevel, number> = {
  0: 6,
  1: 4,
  2: 2,
  3: 0,
  4: 0,
};

/** Expanded (user-pinned) bodies are deliberately generous but finite. */
export const EXPANDED_BODY_LINES = 16;

/** Distance from the tail -> level. Beyond the ladder everything is grouped. */
const LADDER: readonly DetailLevel[] = [0, 1, 2, 3, 4];

export function detailFor(distance: number): DetailLevel {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  const index = Math.min(Math.floor(distance), LADDER.length - 1);
  return LADDER[index] ?? 4;
}

export function bodyLinesFor(level: DetailLevel, expanded = false): number {
  if (expanded) return EXPANDED_BODY_LINES;
  return BODY_LINES[level];
}

/** Total rows a block may occupy, header included. */
export function maxRowsFor(level: DetailLevel, expanded = false): number {
  return 1 + bodyLinesFor(level, expanded);
}

/**
 * Hysteresis: a level only changes after two consecutive recomputes agree.
 * Returns the level to keep. `pending` is undefined when nothing is in flight.
 */
export function settleLevel(
  current: DetailLevel | undefined,
  next: DetailLevel,
  pending: DetailLevel | undefined,
): { level: DetailLevel; pending: DetailLevel | undefined } {
  if (current === undefined) return { level: next, pending: undefined };
  if (current === next) return { level: current, pending: undefined };
  if (pending === next) return { level: next, pending: undefined };
  return { level: current, pending: next };
}
