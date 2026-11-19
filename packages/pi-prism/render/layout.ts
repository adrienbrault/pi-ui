/**
 * Transcript planning: which blocks keep detail, which shrink, which fold.
 * Pure: takes block shapes, returns the order the composer should render.
 */

import { FOLD_DISTANCE, detailFor, type DetailLevel } from "./detail.ts";
import { groupSegments, type GroupSegment } from "./group-row.ts";
import type { GroupClass, ToolClass } from "./tools.ts";

export type BlockClass = ToolClass | "thinking" | "prose";

export interface BlockShape {
  cls: BlockClass;
  failed?: boolean;
}

export type TranscriptItem =
  | { kind: "block"; index: number; level: DetailLevel }
  | { kind: "group"; segments: GroupSegment[]; indices: number[] };

/** Tool calls and thinking fold into summaries; prose anchors never fold. */
function groupable(cls: BlockClass): cls is ToolClass | "thinking" {
  return cls !== "prose";
}

/** Age a block by its distance from the tail. Prose never decays. */
function levelFor(cls: BlockClass, distance: number): DetailLevel {
  if (cls === "prose") return 0;
  return detailFor(distance);
}

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

export function planTranscript(blocks: BlockShape[], historyEnd = blocks.length): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let folded: BlockShape[] = [];
  let foldedIndices: number[] = [];
  let groupItem: Extract<TranscriptItem, { kind: "group" }> | undefined;

  const flush = () => {
    if (!groupItem) return;
    groupItem.segments = groupSegments(folded.map((block) => ({ cls: block.cls as GroupClass, failed: block.failed })));
    // The members a click can reveal: interaction needs the real indices.
    groupItem.indices = [...foldedIndices];
    folded = [];
    foldedIndices = [];
    groupItem = undefined;
  };

  blocks.forEach((block, index) => {
    const distance = Math.max(0, historyEnd - 1 - index);
    const level = levelFor(block.cls, distance);
    if (distance >= FOLD_DISTANCE && groupable(block.cls)) {
      if (!groupItem) {
        // The summary takes the first folded member's place. Keeping the item
        // here lets failures and later members follow it in visual order.
        groupItem = { kind: "group", segments: [], indices: [] };
        items.push(groupItem);
      }
      folded.push(block);
      foldedIndices.push(index);
      return;
    }
    flush();
    items.push({ kind: "block", index, level });
  });

  flush();
  return items;
}
