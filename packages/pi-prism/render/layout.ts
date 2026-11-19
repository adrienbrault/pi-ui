/**
 * Transcript distances: how far each block sits from the tail of its run.
 * Pure, so the live fold planner and the fixture scenarios share one rule.
 */

import { FOLD_DISTANCE } from "./detail.ts";

/** One transcript block as the fold planner weighs it, in visual order. */
export interface PlanBlock {
  kind: "user" | "prose" | "thinking" | "tool";
  /** Thinking runs in the message; each one ages the blocks before it. */
  count?: number;
  /** A thought that shares its message with prose: it anchors like prose. */
  withProse?: boolean;
}

export interface BlockDistance {
  /** Weighted blocks after this one in its run, capped at the fold distance. */
  distance: number;
  /** The first block after a user message. */
  startsRun: boolean;
  /** No user message follows this block. */
  currentRun: boolean;
}

/**
 * The distance rule the live session and the fixtures share. A user message
 * floors everything before it to the fold distance and starts a new run; prose
 * and a thought beside prose add no distance; a thought adds its run count; a
 * tool adds one.
 */
export function blockDistances(blocks: PlanBlock[]): BlockDistance[] {
  const result: BlockDistance[] = Array.from({ length: blocks.length });
  let behind = 0;
  let currentRun = true;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === "user") {
      result[index] = { distance: FOLD_DISTANCE, startsRun: false, currentRun };
      // The block after this one, if any, opens the newer run.
      const next = result[index + 1];
      if (next && blocks[index + 1]?.kind !== "user") next.startsRun = true;
      behind = FOLD_DISTANCE;
      currentRun = false;
      continue;
    }
    result[index] = { distance: Math.min(FOLD_DISTANCE, behind), startsRun: false, currentRun };
    if (block.kind === "tool") behind += 1;
    else if (block.kind === "thinking" && !block.withProse) behind += Math.max(1, block.count ?? 1);
  }
  return result;
}
