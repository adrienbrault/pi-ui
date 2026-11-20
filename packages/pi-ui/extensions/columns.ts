/**
 * Column widths for an open group in the live session. Member rows have two
 * owners, the tool renderer and the thinking decorator; each registers how to
 * read its members' cells, and every member row asks for the same widths.
 */

import { memberColumns, type MemberCells, type MemberColumns } from "../render/columns.ts";
import type { FoldMember, LiveFoldGroup } from "./fold.ts";
import { KIT } from "./kit.ts";

type CellSource = (member: FoldMember) => MemberCells[];

const sources = new Map<FoldMember["kind"], CellSource>();
// Every member row of a group renders in the same pass: work the widths out once per pass.
const cache = new Map<LiveFoldGroup, MemberColumns>();

/** How to read one kind of member's cells: one entry per row it shows (a thought: one per run). */
export function registerMemberCells(kind: FoldMember["kind"], source: CellSource): void {
  sources.set(kind, source);
}

export function groupColumns(group: LiveFoldGroup): MemberColumns {
  const cached = cache.get(group);
  if (cached) return cached;
  if (cache.size === 0) queueMicrotask(() => cache.clear());
  const columns = memberColumns(
    group.members.flatMap((member) => sources.get(member.kind)?.(member) ?? []),
    KIT.visibleWidth,
  );
  cache.set(group, columns);
  return columns;
}
