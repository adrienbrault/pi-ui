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

/** 0 = live. The last level keeps a single body line. Past the ladder a block folds. */
export type DetailLevel =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23;

/** The tail budget: newest keeps this many body lines, then one fewer per turn. */
export const DEFAULT_TAIL_LINES = 8;
export const COMPACT_LEVEL = 23;
const MAX_TAIL_LINES = COMPACT_LEVEL + 1;

let tailLines = DEFAULT_TAIL_LINES;

/**
 * Render-time knob, not per-call state: the gallery sets it once per build so a
 * slider can re-render at another tail budget without threading it through
 * every renderer. Renders are synchronous, so a caller must not interleave.
 */
export function setTailLines(lines: number): void {
  tailLines = Number.isFinite(lines) ? Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(lines))) : DEFAULT_TAIL_LINES;
  FOLD_DISTANCE = Math.max(1, tailLines - 3);
}

export function tailLinesFor(): number {
  return tailLines;
}

/** Bodies under the header per level, from the configured tail budget. */
export function bodyLinesMap(): Record<DetailLevel, number> {
  return Object.fromEntries(
    Array.from({ length: MAX_TAIL_LINES }, (_, level) => [level, Math.max(1, tailLines - level)]),
  ) as Record<DetailLevel, number>;
}

/** Expanded (user-pinned) bodies are deliberately generous but finite. */
export const EXPANDED_BODY_LINES = 16;
/** Maximum body height when the user opens a block all the way. */
export const MAX_FULL_LINES = 400;

/** The last standalone preview reserves three content rows plus its omission notice. */
export let FOLD_DISTANCE = DEFAULT_TAIL_LINES - 3;

/**
 * The newest group of a run shows one row per member while it has at most this
 * many rows, then collapses to its summary. A tool is one row; a thought is
 * one row per run.
 */
export const FORMING_ROWS = 5;

export function detailFor(distance: number): DetailLevel {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  return Math.min(Math.floor(distance), tailLines - 1) as DetailLevel;
}

export function bodyLinesFor(level: DetailLevel, expanded = false): number {
  if (expanded) return EXPANDED_BODY_LINES;
  return Math.max(1, tailLines - level);
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
