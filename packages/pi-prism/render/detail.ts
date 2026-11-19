/**
 * The decay model: how much detail a transcript block earns, by how far it sits
 * from the tail of the current run.
 *
 * Standalone previews fold before their budget drops below three content rows
 * plus the omission notice.
 *
 * Kept dependency-free so the design system and the extension share one source
 * of truth. Recompute on structural events only; never per stream token.
 */

/**
 * 0 = live; each step keeps one body line fewer, down to one at 7. A step is
 * BLOCKS_PER_STEP newer blocks. COMPACT_LEVEL is a folded member's one-row form.
 */
export type DetailLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | typeof COMPACT_LEVEL;

/** The tail budget: newest keeps this many body lines, then one fewer per step. */
export const TAIL_LINES = 8;
export const COMPACT_LEVEL = 23 as const;

/** Expanded (user-pinned) bodies are deliberately generous but finite. */
export const EXPANDED_BODY_LINES = 16;
/** Maximum body height when the user opens a block all the way. */
export const MAX_FULL_LINES = 400;

/** Newer blocks it takes for a preview to lose one line. */
export const BLOCKS_PER_STEP = 2;

/**
 * The last standalone preview reserves three content rows plus its omission
 * notice; distances count newer blocks, so it folds after that many steps.
 */
export const FOLD_DISTANCE = (TAIL_LINES - 3) * BLOCKS_PER_STEP;

/**
 * The newest group of a run shows one row per member while it has at most this
 * many rows, then collapses to its summary. A tool is one row; a thought is
 * one row per run.
 */
export const FORMING_ROWS = 5;

export function detailFor(distance: number): DetailLevel {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.min(Math.floor(distance / BLOCKS_PER_STEP), TAIL_LINES - 1) as DetailLevel;
}

export function bodyLinesFor(level: DetailLevel, expanded = false): number {
  if (expanded) return EXPANDED_BODY_LINES;
  return Math.max(1, TAIL_LINES - level);
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
