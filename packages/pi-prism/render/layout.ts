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

export function planTranscript(blocks: BlockShape[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let folded: BlockShape[] = [];
  let foldedIndices: number[] = [];

  const flush = () => {
    if (folded.length === 0) return;
    items.push({
      kind: "group",
      segments: groupSegments(folded.map((block) => ({ cls: block.cls as GroupClass, failed: block.failed }))),
      // The members a click can reveal: interaction needs the real indices.
      indices: foldedIndices,
    });
    folded = [];
    foldedIndices = [];
  };

  blocks.forEach((block, index) => {
    const distance = blocks.length - 1 - index;
    const level = levelFor(block.cls, distance);
    if (distance >= FOLD_DISTANCE && groupable(block.cls) && !block.failed) {
      folded.push(block);
      foldedIndices.push(index);
      return;
    }
    // A failure or a prose anchor ends the run, so the group keeps its place.
    flush();
    items.push({ kind: "block", index, level });
  });

  flush();
  return items;
}
