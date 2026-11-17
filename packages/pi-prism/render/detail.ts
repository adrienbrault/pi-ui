/**
 * The decay model: how much detail a transcript block earns, by how far it sits
 * from the tail of the current run.
 *
 * Bodies shed one line per turn instead of halving: 7, 6, 5 … 1. A block that
 * is down to its last body line holds that line until the run needs the room,
 * then folds into a group summary. A one-line output therefore never vanishes
 * the turn after it shrinks.
 *
 * Kept dependency-free so the design system and the extension share one source
 * of truth. Recompute on structural events only; never per stream token.
 */

/** 0 = live, 6 = a single body line. Past the ladder a block folds. */
export type DetailLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The tail budget: newest keeps this many body lines, then one fewer per turn. */
export const DEFAULT_TAIL_LINES = 7;
const MAX_TAIL_LINES = 24;

let tailLines = DEFAULT_TAIL_LINES;

/**
 * Render-time knob, not per-call state: the gallery sets it once per build so a
 * slider can re-render at another tail budget without threading it through
 * every renderer. Renders are synchronous, so a caller must not interleave.
 */
export function setTailLines(lines: number): void {
  tailLines = Number.isFinite(lines) ? Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(lines))) : DEFAULT_TAIL_LINES;
}

export function tailLinesFor(): number {
  return tailLines;
}

/** Bodies under the header per level, from the configured tail budget. */
export function bodyLinesMap(): Record<DetailLevel, number> {
  return {
    0: Math.max(1, tailLines),
    1: Math.max(1, tailLines - 1),
    2: Math.max(1, tailLines - 2),
    3: Math.max(1, tailLines - 3),
    4: Math.max(1, tailLines - 4),
    5: Math.max(1, tailLines - 5),
    6: Math.max(1, tailLines - 6),
  };
}

/** Expanded (user-pinned) bodies are deliberately generous but finite. */
export const EXPANDED_BODY_LINES = 16;

/**
 * Distance at which a run stops affording kept blocks: everything older folds
 * into group summaries. One-line blocks survive the whole stretch below it.
 */
export const FOLD_DISTANCE = 8;

export function detailFor(distance: number): DetailLevel {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.min(Math.floor(distance), 6) as DetailLevel;
}

export function bodyLinesFor(level: DetailLevel, expanded = false): number {
  if (expanded) return EXPANDED_BODY_LINES;
  return bodyLinesMap()[level];
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
