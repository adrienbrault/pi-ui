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
