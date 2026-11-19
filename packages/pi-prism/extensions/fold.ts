/**
 * Live fold planning, shared by thinking rows and tool rows.
 *
 * The design system plans one list of blocks, so a run of old thoughts and old
 * tool calls becomes a single summary (`Thought for 12s, ran 8 shell commands`).
 * The live session has two owners for those rows, so they agree on one plan
 * here: patchTree walks the rendered TUI in visual order, hands the units to
 * this module, and both renderers read the result.
 */

import { detailFor, FOLD_DISTANCE, FORMING_ROWS, settleLevel, type DetailLevel } from "../render/detail.ts";
import { groupSegments, type GroupSegment } from "../render/group-row.ts";
import { endFade, fadeOf } from "./fade.ts";
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
  /** Shown open: the user's choice, else whether the group is forming. */
  open: boolean;
  /** The user's choice; undefined while the group follows its size. */
  choice?: boolean;
  /** The newest group of the current run, small enough to list its members. */
  forming: boolean;
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
  /** No user message follows this block; only the current run's newest group forms. */
  currentRun?: boolean;
}

const TOOL_INFO = new Map<string, ToolInfo>();
let toolPlans = new Map<string, FoldPlan>();
const THINKING_PLANS = new WeakMap<object, FoldPlan>();
/** The user's choice per member: open, closed, or absent while the group follows its size. */
const OPEN_THINKING = new WeakMap<object, boolean>();
const OPEN_TOOLS = new Map<string, boolean>();

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

function choiceOf(member: FoldMember): boolean | undefined {
  return member.kind === "thinking" ? OPEN_THINKING.get(member.component) : OPEN_TOOLS.get(member.key);
}

function markOpen(member: FoldMember, open: boolean): void {
  if (member.kind === "thinking") OPEN_THINKING.set(member.component, open);
  else OPEN_TOOLS.set(member.key, open);
}

/**
 * Open or close every member at once: one click on the summary does the lot, and it sticks.
 * The user's choice ends a collapse in progress.
 */
export function setGroupOpen(group: LiveFoldGroup, open: boolean): void {
  endFade(group);
  group.open = open;
  group.choice = open;
  for (const member of group.members) markOpen(member, open);
  group.invalidate();
}

/**
 * A member was opened: the group must not collapse under it when it grows past
 * its forming size. Only an unchosen group changes; a closed one cannot have a
 * visible member to open.
 */
export function keepGroupOpen(group: LiveFoldGroup): void {
  if (group.choice === undefined) setGroupOpen(group, true);
}

/** Rows a group lists when open: a tool is one, a thought one per run. */
export function memberRows(units: FoldMember[]): number {
  return units.reduce((sum, unit) => sum + (unit.kind === "thinking" ? Math.max(1, unit.count) : 1), 0);
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

/**
 * Merged members agree on one choice: any open member opens the group, else any
 * closed one closes it, else the group follows its size.
 */
function groupChoice(members: FoldMember[]): boolean | undefined {
  const choices = new Set(members.map(choiceOf));
  const choice = choices.has(true) ? true : choices.has(false) ? false : undefined;
  if (choice !== undefined) for (const member of members) markOpen(member, choice);
  return choice;
}

function buildGroup(units: FoldUnit[], previous: LiveFoldGroup | undefined, forming: boolean): LiveFoldGroup {
  if (sameGroup(previous, units)) {
    const group = previous!;
    group.choice = groupChoice(group.members);
    group.forming = forming;
    // A collapsing group stays open until its last member row has left.
    group.open = group.choice ?? (forming || !!fadeOf(group));
    return group;
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
  const choice = groupChoice(members);
  const anchor = members[0]!;
  return {
    anchor,
    members,
    segments: groupSegments(rows),
    tokens: members.every((member) => member.tokens) ? sumTokens(members.map((member) => member.tokens!)) : undefined,
    ...(durationMs !== undefined ? { durationMs } : {}),
    open: choice ?? forming,
    ...(choice !== undefined ? { choice } : {}),
    forming,
    invalidate: () => {
      for (const member of members) member.invalidate();
    },
  };
}

function previousPlan(unit: FoldUnit): FoldPlan | undefined {
  return unit.kind === "thinking" ? THINKING_PLANS.get(unit.component) : toolPlans.get(unit.key);
}

/**
 * How a member's row looks while its group collapses: gone once the collapse
 * has passed it or when it was not listed as the collapse began, fading at the
 * frame's phase while it is the bottom listed row, else as usual. A thought has
 * one row per run. Undefined when the group is not collapsing.
 */
export function memberRowFade(
  group: LiveFoldGroup,
  member: string | object,
  run = 0,
): { gone: boolean; phase: number } | undefined {
  const frame = fadeOf(group);
  // The user's choice overrides a collapse.
  if (!frame?.shown || group.choice !== undefined) return undefined;
  let row = 0;
  for (const item of group.members) {
    const mine = item.kind === "tool" ? item.key === member : item.component === member;
    if (!frame.shown.has(item.component)) {
      if (mine) return { gone: true, phase: 0 };
      continue;
    }
    if (mine) {
      row += run;
      break;
    }
    row += memberRows([item]);
  }
  const fading = frame.foldRows - frame.removed - 1;
  return { gone: row > fading, phase: row === fading ? frame.phase : 0 };
}

/**
 * Whether the unit at `index`, stepping to the fold distance, joins a group that
 * will list it: one the user opened, or one that still forms (the newest group
 * of the current run, at most FORMING_ROWS rows once it counts the joiner) and
 * that the user has not closed. Such a block keeps its heading as its member row.
 */
export function joinsOpenGroup(units: FoldUnit[], index: number): boolean {
  const joiner = units[index];
  if (!joiner || joiner.boundary) return false;
  const group = [joiner];
  for (let before = index - 1; before >= 0 && !group[0]!.startsRun; before--) {
    const unit = units[before]!;
    if (unit.boundary || unit.distance < FOLD_DISTANCE) break;
    group.unshift(unit);
  }
  const choices = new Set(group.map(choiceOf));
  if (choices.has(true)) return true;
  if (choices.has(false)) return false;
  return joiner.currentRun !== false && memberRows(group) <= FORMING_ROWS;
}

/**
 * Turn units into plans. A contiguous run of units past the fold distance is a
 * group; a boundary or a recent unit ends it and keeps its own row. The first
 * member owns the summary, the rest render nothing until the group opens. The
 * newest group of the current run forms: it lists its members while it holds at
 * most FORMING_ROWS rows.
 */
export function planFolds(
  units: FoldUnit[],
  animated?: object,
  /** A group that listed its members because it was forming no longer forms; `shown` were listed. */
  onCollapse?: (group: LiveFoldGroup, shown: Set<object>) => void,
): Set<object> {
  const nextTools = new Map<string, FoldPlan>();
  const changed = new Set<object>();
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

  const blocks: Array<FoldUnit | FoldUnit[]> = [];
  let run: FoldUnit[] = [];
  const flush = (): void => {
    if (run.length) blocks.push(run);
    run = [];
  };
  for (const unit of units) {
    if (unit.startsRun) flush();
    if (!unit.boundary && unit.distance >= FOLD_DISTANCE) {
      run.push(unit);
      continue;
    }
    flush();
    blocks.push(unit);
  }
  flush();

  const newest = blocks.findLast((block) => Array.isArray(block));
  for (const block of blocks) {
    if (!Array.isArray(block)) {
      assign(block, "normal");
      continue;
    }
    const forming = block === newest && block.at(-1)!.currentRun !== false && memberRows(block) <= FORMING_ROWS;
    // Members that a forming group listed, whichever group they belonged to: merging
    // a closed group with a forming one must still let the forming rows leave.
    const shown = new Set<object>();
    for (const unit of block) {
      const before = previousPlan(unit)?.group;
      if (before?.forming && before.open && before.choice === undefined) shown.add(unit.component);
    }
    const previous = previousPlan(block[0]!)?.group;
    const wasOpen = previous?.open;
    const group = buildGroup(block, previous, forming);
    if (shown.size && !group.forming && group.choice === undefined) onCollapse?.(group, shown);
    // A reused group that opens or closes must render its members again.
    if (group === previous && wasOpen !== group.open) for (const unit of block) changed.add(unit.component);
    block.forEach((unit, index) => {
      assign(unit, index === 0 ? "anchor" : "hidden", group);
    });
  }
  toolPlans = nextTools;
  return changed;
}
