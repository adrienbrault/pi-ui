/**
 * Live fold planning, shared by thinking rows and tool rows.
 *
 * The design system plans one list of blocks, so a run of old thoughts and old
 * tool calls becomes a single summary (`Thought 3 times · Ran 8 commands`).
 * The live session has two owners for those rows, so they agree on one plan
 * here: patchTree walks the rendered TUI in visual order, hands the units to
 * this module, and both renderers read the result.
 */

import { FOLD_DISTANCE } from "../render/detail.ts";
import { groupSegments, type GroupSegment } from "../render/group-row.ts";
import type { ToolStatus } from "../render/tool-row.ts";
import type { GroupClass } from "../render/tools.ts";

export type FoldMode = "normal" | "hidden" | "anchor";

/** What the tool renderer knows beyond the component in the tree. */
export interface ToolInfo {
  name: string;
  status: ToolStatus;
  durationMs?: number;
}

export interface FoldMember {
  kind: "thinking" | "tool";
  /** Tool call id, or a stable label for a thinking component. */
  key: string;
  component: object;
  count: number;
  cls: GroupClass;
  failed?: boolean;
  durationMs?: number;
  invalidate: () => void;
}

export interface LiveFoldGroup {
  anchor: FoldMember;
  members: FoldMember[];
  segments: GroupSegment[];
  durationMs?: number;
  open: boolean;
  invalidate: () => void;
}

export interface FoldPlan {
  mode: FoldMode;
  group?: LiveFoldGroup;
}

/** patchTree's input: one unit per foldable component, in visual order. */
export interface FoldUnit extends FoldMember {
  /** Foldable blocks after this one in the run. */
  distance: number;
  /** Prose and failures keep their own row and end a group. */
  boundary?: boolean;
}

const TOOL_INFO = new Map<string, ToolInfo>();
const TOOL_PLANS = new Map<string, FoldPlan>();
const THINKING_PLANS = new WeakMap<object, FoldPlan>();
const OPEN_THINKING = new WeakSet<object>();
const OPEN_TOOLS = new Set<string>();

export function registerToolInfo(key: string, info: ToolInfo): void {
  TOOL_INFO.set(key, info);
}

export function toolInfo(key: string): ToolInfo | undefined {
  return TOOL_INFO.get(key);
}

export function toolPlan(key: string): FoldPlan | undefined {
  return TOOL_PLANS.get(key);
}

export function thinkingPlan(component: object): FoldPlan | undefined {
  return THINKING_PLANS.get(component);
}

function isOpen(member: FoldMember): boolean {
  return member.kind === "thinking" ? OPEN_THINKING.has(member.component) : OPEN_TOOLS.has(member.key);
}

function markOpen(member: FoldMember, open: boolean): void {
  if (member.kind === "thinking") {
    if (open) OPEN_THINKING.add(member.component);
    else OPEN_THINKING.delete(member.component);
    return;
  }
  if (open) OPEN_TOOLS.add(member.key);
  else OPEN_TOOLS.delete(member.key);
}

/** Open or close every member at once: one click on the summary does the lot. */
export function setGroupOpen(group: LiveFoldGroup, open: boolean): void {
  group.open = open;
  markOpen(group.anchor, open);
  group.invalidate();
}

function sameGroup(previous: LiveFoldGroup | undefined, units: FoldUnit[]): boolean {
  if (!previous || previous.members.length !== units.length) return false;
  return units.every((unit, index) => {
    const member = previous.members[index];
    return (
      member?.component === unit.component &&
      member.key === unit.key &&
      member.kind === unit.kind &&
      member.count === unit.count &&
      member.failed === unit.failed &&
      member.durationMs === unit.durationMs
    );
  });
}

function buildGroup(units: FoldUnit[], previous: LiveFoldGroup | undefined): LiveFoldGroup {
  if (sameGroup(previous, units)) {
    previous!.open = isOpen(previous!.anchor);
    return previous!;
  }
  const members = units.map((unit) => ({ ...unit }));
  const rows = members.flatMap((member) =>
    Array.from({ length: member.kind === "thinking" ? member.count : 1 }, () => ({
      cls: member.cls,
      failed: member.failed,
    })),
  );
  const timed = members.filter((member) => member.durationMs !== undefined);
  const durationMs = timed.length > 0 ? timed.reduce((sum, member) => sum + (member.durationMs ?? 0), 0) : undefined;
  const anchor = members[0]!;
  return {
    anchor,
    members,
    segments: groupSegments(rows),
    ...(durationMs !== undefined ? { durationMs } : {}),
    open: isOpen(anchor),
    invalidate: () => {
      for (const member of members) member.invalidate();
    },
  };
}

function assign(unit: FoldUnit, plan: FoldPlan, changed: Set<object>): void {
  const previous = unit.kind === "thinking" ? THINKING_PLANS.get(unit.component) : TOOL_PLANS.get(unit.key);
  if (unit.kind === "thinking") THINKING_PLANS.set(unit.component, plan);
  else TOOL_PLANS.set(unit.key, plan);
  if (!previous || previous.mode !== plan.mode || previous.group !== plan.group) changed.add(unit.component);
}

/**
 * Turn units into plans. A contiguous run of units past the fold distance is a
 * group; a boundary or a recent unit ends it and keeps its own row. The first
 * member owns the summary, the rest render nothing until the group opens.
 */
export function planFolds(units: FoldUnit[]): Set<object> {
  TOOL_PLANS.clear();
  const changed = new Set<object>();
  let run: FoldUnit[] = [];
  let previousGroup: LiveFoldGroup | undefined;

  const flush = (): void => {
    if (run.length === 0) return;
    const group = buildGroup(run, previousGroup);
    previousGroup = group;
    run.forEach((unit, index) => {
      assign(unit, { mode: index === 0 ? "anchor" : "hidden", group }, changed);
    });
    run = [];
  };

  for (const unit of units) {
    if (!unit.boundary && unit.distance >= FOLD_DISTANCE) {
      run.push(unit);
      continue;
    }
    flush();
    previousGroup = undefined;
    assign(unit, { mode: "normal" }, changed);
  }
  flush();
  return changed;
}
