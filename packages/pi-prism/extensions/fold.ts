/**
 * Live fold planning, shared by thinking rows and tool rows.
 *
 * The design system plans one list of blocks, so a run of old thoughts and old
 * tool calls becomes a single summary (`Thought for 12s, ran 8 shell commands`).
 * The live session has two owners for those rows, so they agree on one plan
 * here: patchTree walks the rendered TUI in visual order, hands the units to
 * this module, and both renderers read the result.
 */

import { detailFor, FOLD_DISTANCE, settleLevel, type DetailLevel } from "../render/detail.ts";
import { groupSegments, type GroupSegment } from "../render/group-row.ts";
import type { ToolStatus } from "../render/tool-row.ts";
import { sumTokens, type TokenCounts, type GroupClass } from "../render/tools.ts";

export type FoldMode = "normal" | "hidden" | "anchor";

/** What the tool renderer knows beyond the component in the tree. */
export interface ToolInfo {
  name: string;
  status: ToolStatus;
  pinned: boolean;
  tokens?: TokenCounts;
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
  tokens?: TokenCounts;
  startedAt?: number;
  endedAt?: number;
  /** Time spent thinking or running; absent when it was not recorded. */
  activeMs?: number;
  invalidate: () => void;
}

export interface LiveFoldGroup {
  anchor: FoldMember;
  members: FoldMember[];
  segments: GroupSegment[];
  tokens?: TokenCounts;
  durationMs?: number;
  open: boolean;
  invalidate: () => void;
}

export interface FoldPlan {
  level: DetailLevel;
  pending?: DetailLevel;
  mode: FoldMode;
  group?: LiveFoldGroup;
}

/** patchTree's input: one unit per foldable component, in visual order. */
export interface FoldUnit extends FoldMember {
  /** Foldable blocks after this one in the run. */
  distance: number;
  /** Keeps its own row instead of joining the summary. */
  boundary?: boolean;
  startsRun?: boolean;
}

const TOOL_INFO = new Map<string, ToolInfo>();
let toolPlans = new Map<string, FoldPlan>();
const THINKING_PLANS = new WeakMap<object, FoldPlan>();
const OPEN_THINKING = new WeakSet<object>();
const OPEN_TOOLS = new Set<string>();

export function resetFolds(): void {
  TOOL_INFO.clear();
  toolPlans.clear();
  OPEN_TOOLS.clear();
}

/** Only structural changes can affect the plan. Partial output stays local to the row. */
export function registerToolInfo(key: string, info: ToolInfo): boolean {
  const old = TOOL_INFO.get(key);
  if (
    old?.name === info.name &&
    old.status === info.status &&
    old.durationMs === info.durationMs &&
    old.tokens?.inputTokens === info.tokens?.inputTokens &&
    old.tokens?.outputTokens === info.tokens?.outputTokens &&
    old.pinned === info.pinned
  )
    return false;
  TOOL_INFO.set(key, info);
  return true;
}

export function toolInfo(key: string): ToolInfo | undefined {
  return TOOL_INFO.get(key);
}

export function toolPlan(key: string): FoldPlan | undefined {
  return toolPlans.get(key);
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
  for (const member of group.members) markOpen(member, open);
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
      member.cls === unit.cls &&
      member.count === unit.count &&
      member.failed === unit.failed &&
      member.tokens?.inputTokens === unit.tokens?.inputTokens &&
      member.tokens?.outputTokens === unit.tokens?.outputTokens &&
      member.startedAt === unit.startedAt &&
      member.endedAt === unit.endedAt &&
      member.activeMs === unit.activeMs
    );
  });
}

/** Wall-clock span, including model responses and counting overlapping calls once. */
function elapsedMs(members: FoldMember[]): number | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const { startedAt, endedAt } of members) {
    if (
      startedAt === undefined ||
      endedAt === undefined ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      endedAt < startedAt
    )
      return undefined;
    start = Math.min(start, startedAt);
    end = Math.max(end, endedAt);
  }
  return end - start;
}

function buildGroup(units: FoldUnit[], previous: LiveFoldGroup | undefined): LiveFoldGroup {
  if (sameGroup(previous, units)) {
    previous!.open = isOpen(previous!.anchor);
    return previous!;
  }
  const members = units.map((unit) => ({ ...unit }));
  const rows = members.map((member) => ({
    cls: member.cls,
    count: member.kind === "thinking" ? member.count : 1,
    failed: member.failed,
    durationMs: member.activeMs,
  }));
  const durationMs = elapsedMs(members);
  // A finishing tool can merge two groups or replace the summary anchor.
  const open = members.some(isOpen);
  if (open) {
    for (const member of members) markOpen(member, true);
  }
  const anchor = members[0]!;
  return {
    anchor,
    members,
    segments: groupSegments(rows),
    tokens: members.every((member) => member.tokens) ? sumTokens(members.map((member) => member.tokens!)) : undefined,
    ...(durationMs !== undefined ? { durationMs } : {}),
    open,
    invalidate: () => {
      for (const member of members) member.invalidate();
    },
  };
}

function previousPlan(unit: FoldUnit): FoldPlan | undefined {
  return unit.kind === "thinking" ? THINKING_PLANS.get(unit.component) : toolPlans.get(unit.key);
}

/**
 * Turn units into plans. A contiguous run of units past the fold distance is a
 * group; a boundary or a recent unit ends it and keeps its own row. The first
 * member owns the summary, the rest render nothing until the group opens.
 */
export function planFolds(units: FoldUnit[], animated?: object): Set<object> {
  const nextTools = new Map<string, FoldPlan>();
  const changed = new Set<object>();
  let run: FoldUnit[] = [];
  const assign = (unit: FoldUnit, mode: FoldMode, group?: LiveFoldGroup): void => {
    const previous = previousPlan(unit);
    const target = detailFor(unit.distance);
    // The animation has already held this target across both frames.
    const age = settleLevel(previous?.level, target, unit.component === animated ? target : previous?.pending);
    const plan = { ...age, mode, group };
    if (unit.kind === "thinking") THINKING_PLANS.set(unit.component, plan);
    else nextTools.set(unit.key, plan);
    if (previous?.mode !== mode || previous.group !== group || previous.level !== age.level) {
      changed.add(unit.component);
    }
  };

  const flush = (): void => {
    if (run.length === 0) return;
    const group = buildGroup(run, previousPlan(run[0]!)?.group);
    run.forEach((unit, index) => {
      assign(unit, index === 0 ? "anchor" : "hidden", group);
    });
    run = [];
  };

  for (const unit of units) {
    if (unit.startsRun) flush();
    if (!unit.boundary && unit.distance >= FOLD_DISTANCE) {
      run.push(unit);
      continue;
    }
    flush();
    assign(unit, "normal");
  }
  flush();
  toolPlans = nextTools;
  return changed;
}
