/**
 * One age ladder for tool rows in a run.
 *
 * Callers keep the returned `{ run, seq }` and ask for its level at render
 * time; the ladder itself owns the invalidation of rows whose level moved.
 * Thinking rows derive their level from their place in the rendered tree (see
 * `thinking.ts`), because restored assistant components are patched after the
 * tool rows have already taken their sequence numbers.
 */

import { detailFor, type DetailLevel } from "../render/detail.ts";

interface AgedRow {
  run: number;
  seq: number;
  level: DetailLevel;
  invalidate: () => void;
}

export interface Age {
  run: number;
  seq: number;
}

let run = 0;
let seq = 0;
const aged: AgedRow[] = [];

/** The run the transcript is currently in; older runs sit at the floor. */
export function runIndex(): number {
  return run;
}

/** Latest sequence number in the current run. */
export function sequenceIndex(): number {
  return seq;
}

/**
 * Register a block in the current run. Older rows in the same run move one step
 * down and repaint; a new block takes the head at level 0.
 */
export function registerAge(invalidate: () => void): Age {
  const next = ++seq;
  for (const row of aged) {
    if (row.run !== run) continue;
    const level = detailFor(next - row.seq);
    if (level === row.level) continue;
    row.level = level;
    row.invalidate();
  }
  aged.push({ run, seq: next, level: 0, invalidate });
  // Once a row is at the floor it never moves again: drop it from the window.
  while (aged[0]?.run === run && aged[0]?.level === 6) aged.shift();
  return { run, seq: next };
}

/** A block's detail level: newest is 0, past the ladder is 6. */
export function levelFor(ageRun: number, ageSeq: number): DetailLevel {
  if (ageRun !== run) return 6;
  return detailFor(seq - ageSeq);
}

/**
 * End the run: everything still above the floor drops to a single line, then
 * the ladder restarts empty for the new run.
 */
export function startRun(): void {
  const previous = [...aged];
  run += 1;
  seq = 0;
  aged.length = 0;
  for (const row of previous) {
    row.level = 6;
    row.invalidate();
  }
}

/** A fresh session starts the ladder over. */
export function resetAge(): void {
  run = 0;
  seq = 0;
  aged.length = 0;
}
