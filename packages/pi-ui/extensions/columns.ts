/**
 * Column widths for an open group in the live session. Member rows have two
 * owners, the tool renderer and the thinking decorator; each registers how to
 * read its members' cells, and every member row asks for the same widths.
 */

import {
  ALL_LABELS,
  columnLabelRows,
  memberColumns,
  type ColumnLabels,
  type MemberCells,
  type MemberColumns,
} from "../render/columns.ts";
import type { FoldMember, LiveFoldGroup } from "./fold.ts";
import { KIT } from "./kit.ts";

type CellSource = (member: FoldMember) => MemberCells[];

const sources = new Map<FoldMember["kind"], CellSource>();
interface GroupTable {
  columns: MemberColumns;
  /** Each member's rows' column words, keyed as fold keys members: a tool by its key, a thought by its component. */
  labels: Map<string | object, ColumnLabels[]>;
}

// Every member row of a group renders in the same pass: work the table out once per pass.
const cache = new Map<LiveFoldGroup, GroupTable>();

/** How to read one kind of member's cells: one entry per row it shows (a thought: one per run). */
export function registerMemberCells(kind: FoldMember["kind"], source: CellSource): void {
  sources.set(kind, source);
}

function groupTable(group: LiveFoldGroup): GroupTable {
  const cached = cache.get(group);
  if (cached) return cached;
  if (cache.size === 0) queueMicrotask(() => cache.clear());
  const rows = group.members.map((member) => ({
    owner: member.kind === "tool" ? member.key : member.component,
    cells: sources.get(member.kind)?.(member) ?? [],
  }));
  const all = rows.flatMap((row) => row.cells);
  const words = columnLabelRows(all);
  const labels = new Map<string | object, ColumnLabels[]>();
  let next = 0;
  for (const row of rows) {
    labels.set(row.owner, words.slice(next, next + row.cells.length));
    next += row.cells.length;
  }
  const table = { columns: memberColumns(all, KIT.visibleWidth), labels };
  cache.set(group, table);
  return table;
}

export function groupColumns(group: LiveFoldGroup): MemberColumns {
  return groupTable(group).columns;
}

/** The column words a member's row writes: a tool by its key, a thought by its component and run. */
export function groupColumnLabels(group: LiveFoldGroup, owner: string | object, run = 0): ColumnLabels {
  return groupTable(group).labels.get(owner)?.[run] ?? ALL_LABELS;
}
