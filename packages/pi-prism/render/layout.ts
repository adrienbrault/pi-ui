/**
 * Transcript planning: which blocks keep detail, which shrink, which fold.
 * Pure: takes block shapes, returns the order the composer should render.
 */

import { FOLD_DISTANCE, detailFor, type DetailLevel } from "./detail.ts";
import { groupSegments, type GroupSegment } from "./group-row.ts";
import type { ToolClass } from "./tools.ts";

export type BlockClass = ToolClass | "thinking" | "prose";

export interface BlockShape {
  cls: BlockClass;
  failed?: boolean;
}

export type TranscriptItem =
  | { kind: "block"; index: number; level: DetailLevel }
  | { kind: "group"; segments: GroupSegment[] };

/** Only tool calls fold into summaries; prose anchors and thinking keep a line. */
function groupable(cls: BlockClass): cls is ToolClass {
  return cls !== "thinking" && cls !== "prose";
}

/**
 * Age a block by its distance from the tail. Prose never decays; thinking
 * bottoms out at one tail line rather than joining a group.
 */
function levelFor(cls: BlockClass, distance: number): DetailLevel {
  if (cls === "prose") return 0;
  const level = detailFor(distance);
  return cls === "thinking" ? (Math.min(level, 6) as DetailLevel) : level;
}

export function planTranscript(blocks: BlockShape[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let folded: BlockShape[] = [];

  const flush = () => {
    if (folded.length === 0) return;
    items.push({
      kind: "group",
      segments: groupSegments(folded.map((block) => ({ cls: block.cls as ToolClass, failed: block.failed }))),
    });
    folded = [];
  };

  blocks.forEach((block, index) => {
    const distance = blocks.length - 1 - index;
    const level = levelFor(block.cls, distance);
    if (distance >= FOLD_DISTANCE && groupable(block.cls) && !block.failed) {
      folded.push(block);
      return;
    }
    // A failure or a prose anchor ends the run, so the group keeps its place.
    flush();
    items.push({ kind: "block", index, level });
  });

  flush();
  return items;
}
