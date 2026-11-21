/**
 * Thinking rows, decorated on the live assistant component.
 *
 * pi renders thinking inside `AssistantMessageComponent`; extensions get only
 * `ui.setHiddenThinkingLabel`, one string shared by every message. That is
 * enough for a single label but not for a per-run tail. We capture the TUI from
 * a zero-height widget factory, find the assistant components, and wrap their
 * `updateContent`: after pi builds the hidden label we replace that label's
 * component with our own. The surrounding MouseRegion stays, so pi's own click
 * still expands and collapses the run.
 *
 * This is internal component shape, so installation is best-effort: when the
 * TUI or a component does not match, pi's native label remains untouched.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BLOCKS_PER_STEP, COMPACT_LEVEL, detailFor, FOLD_DISTANCE, type DetailLevel } from "../render/detail.ts";
import { glyphsFor } from "../render/glyphs.ts";
import { renderGroupMember, renderGroupRow } from "../render/group-row.ts";
import { KIT } from "./kit.ts";
import { cutMark, type RenderTheme } from "../render/kit.ts";
import { estimatedTokens, toolMeta } from "../render/tools.ts";
import {
  composeThinkingLabel,
  THINKING_LABEL,
  thoughtCells,
  thinkingFrame,
  thinkingLeavingRow,
  type ThinkingLabelInput,
} from "../render/thinking.ts";
import { advanceTailWindow, isDropping, planTailWindow, type TailWindow } from "../render/window.ts";
import { blockDistances, type PlanBlock } from "../render/layout.ts";
import type { MemberCells } from "../render/columns.ts";
import { groupColumnLabels, groupColumns, registerMemberCells } from "./columns.ts";
import {
  type FoldMember,
  type FoldPlan,
  type FoldUnit,
  joinsOpenGroup,
  keepGroupOpen,
  type LiveFoldGroup,
  memberRowFade,
  memberRows,
  planFolds,
  setGroupOpen,
  stepPlanLevel,
  thinkingPlan,
  toolInfo,
  toolPlan,
} from "./fold.ts";
import {
  decorateViewport,
  expandedRegions,
  hoveredRegions,
  insideExpanded,
  insideHovered,
  offscreenHistory,
  paintBar,
  paintMarker,
  styleBarCell,
  type BarCell,
  type TranscriptTui,
} from "./viewport.ts";
import { installThinkingClock, recordedThinkingMs, thinkingTime, type TimedMessage } from "./thinking-time.ts";
import { claimHover, clearHover, onSpacerMouse, releaseHover } from "./hover.ts";
import { restyleUserMessage } from "./user-message.ts";
import {
  advanceFade,
  backlogIntervalMs,
  backlogRows,
  type DecayFrame,
  endFade,
  fadeLine,
  FADE_FRAMES,
  fadeDurationMs,
  blocksArrived,
  FOLD_LEVEL,
  type PaceClock,
  fadeOf,
  moveFade,
  paintFold,
  paintLeaving,
  resetFades,
  startFade,
} from "./fade.ts";

const GLYPHS = glyphsFor("unicode");
const PROBE_WIDGET = "pi-ui-thinking-probe";

interface ContentEntry {
  type: string;
  thinking?: string;
  text?: string;
}

interface ToolComponentLike extends Partial<Component> {
  selfRenderHeight?: number;
  selfRenderContainer?: Parameters<typeof insideExpanded>[0];
  toolCallId?: string;
  toolName?: string;
  rendererState?: unknown;
  result?: { timestamp?: number };
  invalidate?: () => void;
}

interface AssistantLike extends TimedMessage {
  usage?: { reasoning?: number };
  content?: ContentEntry[];
  timestamp?: number;
  contentContainer?: { children?: unknown[] };
  thinkingVisibilityOverrides?: Map<number, boolean>;
  hideThinkingBlock?: boolean;
  hiddenThinkingLabel?: string;
  isStreaming?: boolean;
  outputPad?: number;
  render?: (width: number) => string[];
  updateContent?: (message: AssistantLike, streaming?: boolean) => void;
  lastMessage?: AssistantLike;
  invalidate?: () => void;
}

interface MouseEventLike {
  type?: string;
  y?: number;
}

interface HoverState {
  target?: "summary" | "thought";
  canToggle: boolean;
  expanded?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface HiddenThinkingRegion {
  child: unknown;
  onMouse: (event: MouseEventLike) => unknown;
  piUiHover?: HoverState;
}

/** One hover state per thinking run, so a rebuilt region does not reset it. */
const HOVERS = new WeakMap<object, HoverState[]>();

/** Live thinking advances its tail by one row per tick. */
const ERASE_MS = 90;

interface EraseState {
  window?: TailWindow;
  timer?: ReturnType<typeof setTimeout>;
}

const ERASES = new WeakMap<object, Array<EraseState | undefined>>();

const NORMAL_PLAN: FoldPlan = { mode: "normal", level: 0 };

/** The width each block last rendered at: a backlog tick renders it again to see what a step takes away. */
const WIDTHS = new WeakMap<object, number>();

/** Tool rows register their metadata then ask the tree plan to recompute. */
let scheduleFold: (() => void) | undefined;

export function scheduleThinkingFold(): void {
  scheduleFold?.();
}

interface ContainerLike {
  children?: unknown[];
  updateContent?: unknown;
  contentContainer?: unknown;
  thinkingVisibilityOverrides?: unknown;
}

interface ThinkingRun {
  text: string;
  first: number;
  chars: number;
}

/** Recorded thinking time of a message's runs; absent unless every run was timed. */
function thinkingMs(message: AssistantLike | undefined, runs: ThinkingRun[]): number | undefined {
  const recorded = recordedThinkingMs(message);
  if (!recorded || runs.length === 0) return undefined;
  let total = 0;
  for (const run of runs) {
    const elapsed = recorded[run.first];
    if (elapsed === undefined) return undefined;
    total += elapsed;
  }
  return total;
}

function thinkingRuns(message: AssistantLike): ThinkingRun[] {
  const content = message.content ?? [];
  const runs: ThinkingRun[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index]?.type !== "thinking") continue;
    const first = index;
    let chars = 0;
    const blocks: string[] = [];
    for (; index < content.length; index += 1) {
      const entry = content[index];
      if (entry?.type !== "thinking") break;
      chars += entry.thinking?.length ?? 0;
      const text = entry.thinking;
      if (text?.trim()) blocks.push(text);
    }
    index -= 1;
    if (blocks.length > 0) runs.push({ text: blocks.join("\n\n"), first, chars });
  }
  return runs;
}

function reportedReasoning(message: AssistantLike | undefined, runs: number, streaming = false): number | undefined {
  const count = message?.usage?.reasoning;
  return !streaming && runs === 1 && count !== undefined && count > 0 ? count : undefined;
}

function isHiddenThinking(component: unknown): component is HiddenThinkingRegion {
  const candidate = component as Partial<HiddenThinkingRegion> & { child?: { setText?: unknown } };
  return (
    typeof candidate.onMouse === "function" &&
    typeof candidate.child === "object" &&
    candidate.child !== null &&
    typeof candidate.child.setText === "function"
  );
}

function bindHover(
  region: HiddenThinkingRegion,
  component: AssistantLike,
  state: HoverState,
  foldOf: () => FoldPlan,
): void {
  const original = region.onMouse;
  const clear = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.target = undefined;
    component.invalidate?.();
  };
  region.onMouse = (event: MouseEventLike) => {
    if (event.type !== "move" && event.type !== "click") return original.call(region, event);
    const plan = foldOf();
    const summary = plan.mode === "anchor" && plan.group && (event.y ?? 0) === 0;
    // A thought with nothing more to show is inert: no bar, no click.
    if (!summary && !state.canToggle) {
      const changed = clearHover();
      return { handled: true, render: changed };
    }
    const target = summary ? "summary" : "thought";
    const changed = state.target !== target;
    claimHover(state, clear);
    state.target = target;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      releaseHover(state);
      clear();
    }, 1200);
    if (event.type === "click" && plan.group && summary) {
      setGroupOpen(plan.group, !plan.group.open);
      return { handled: true, render: true };
    }
    if (event.type === "click") {
      // Any row of a thought that can open opens it; any row of an open thought closes it.
      // Opening a member keeps a forming group from collapsing under it.
      if (!state.expanded && plan.group) keepGroupOpen(plan.group);
      return original.call(region, event);
    }
    if (changed) component.invalidate?.();
    return { handled: true, render: changed };
  };
}

function scheduleErase(repaint: () => void, state: EraseState): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (!state.window || !isDropping(state.window)) return;
    state.window = advanceTailWindow(state.window);
    repaint();
  }, ERASE_MS);
}

function labelComponent(
  run: ThinkingRun,
  message: AssistantLike,
  reasoningTokens: number | undefined,
  streaming: boolean,
  theme: RenderTheme,
  hover: HoverState,
  erase: EraseState,
  repaint: () => void,
  owner: object,
  levelOf: () => DetailLevel,
  foldOf: () => FoldPlan,
  expanded: boolean,
  /** This run's place among the message's thinking rows. */
  ordinal: number,
): Component {
  return {
    render(width: number): string[] {
      const plan = foldOf();
      const group = plan.group;
      if (plan.mode === "hidden" && !group?.open) return [];
      const api = { kit: KIT, theme, glyphs: GLYPHS };
      let settled: ThinkingLabelInput | undefined;
      let bar: BarCell[] | undefined;
      let oneRow = false;
      const thoughtLines = (innerWidth: number): string[] => {
        const timing = thinkingTime(message, run.first, streaming);
        const level: DetailLevel = group ? COMPACT_LEVEL : streaming ? 0 : levelOf();
        const input: ThinkingLabelInput = {
          ...(group ? { columns: groupColumns(group), columnLabels: groupColumnLabels(group, owner, ordinal) } : {}),
          ...timing,
          estimatedTokens: estimatedTokens(run.chars),
          reasoningTokens,
          phase: timing.running ? "thinking" : "aged",
          level,
          text: run.text,
          width: Math.max(1, innerWidth),
          frame: Math.floor(Date.now() / 120),
          expanded,
          // Hovering a thought a click would open or close lights its notices.
          lit: hover.target === "thought" && hover.canToggle,
        };
        settled = input;
        const animate = timing.running && streaming && !expanded && !group;
        if (!animate) {
          clearTimeout(erase.timer);
          erase.timer = undefined;
          erase.window = undefined;
        }
        const frame = thinkingFrame(
          { ...api, owner: hover },
          input,
          animate
            ? (total, keep) => {
                erase.window = planTailWindow(total, keep, erase.window);
                if (isDropping(erase.window)) scheduleErase(repaint, erase);
                return erase.window.rows;
              }
            : undefined,
        );
        const layout = composeThinkingLabel(api, input, frame);
        hover.canToggle = layout.canToggle && (!streaming || expanded);
        hover.expanded = expanded;
        const lines = layout.label.split("\n");
        // Hover marks a thought that can open with its preview bar; a one-row thought gets one filled cell.
        // An open thought carries the open-block bar instead.
        const marked = hover.canToggle && !expanded && hover.target === "thought";
        bar = marked ? layout.bar : undefined;
        oneRow = marked && !layout.bar && lines.length === 1;
        return lines;
      };
      const paint = (rows: string[]): string[] => {
        if (bar?.length)
          paintBar(rows, rows.length - bar.length, bar, (cell, lit) => styleBarCell(theme, cell, lit), width);
        else if (oneRow && rows[0] !== undefined) rows[0] = paintMarker(rows[0], theme, width);
        return rows;
      };
      if (!group) {
        const lines = thoughtLines(width);
        const frame = fadeOf(owner);
        if (streaming || expanded || !frame || frame.folding || !settled) return paint(lines);
        return paint(paintLeaving(lines, thinkingLeavingRow(api, settled), frame, theme, ordinal));
      }
      const memberLines = () => {
        const rows = renderGroupMember(KIT, width, thoughtLines, cutMark(theme));
        // A collapsing group drops its member rows from the bottom, one fade each.
        const collapse = memberRowFade(group, owner, ordinal);
        if (collapse?.gone) return [];
        if (collapse?.phase) return rows.map((row) => fadeLine(row, collapse.phase, theme));
        return paint(rows);
      };
      if (plan.mode === "hidden") return memberLines();
      const summary =
        renderGroupRow(api, {
          segments: group.segments,
          tokens: group.tokens,
          expanded: group.open,
          durationMs: group.durationMs,
        }).render(width)[0] ?? "";
      // Hover marks the summary with one filled bar cell: a click anywhere on it opens or closes the group.
      const rows = [hover.target === "summary" ? paintMarker(summary, theme, width) : summary];
      return group.open ? [...rows, ...memberLines()] : rows;
    },
    invalidate(): void {},
  };
}

function bindSpacer(component: unknown): void {
  const spacer = component as { setLines?: unknown; lines?: number; handleMouse?: unknown };
  if (typeof spacer?.setLines === "function" && typeof spacer.lines === "number" && !spacer.handleMouse) {
    spacer.handleMouse = onSpacerMouse;
  }
}

function suppressThinkingSpacer(children: unknown[], region: HiddenThinkingRegion): void {
  const spacer = children[children.indexOf(region) - 1] as
    | { lines?: number; setLines?: (count: number) => void }
    | undefined;
  if (spacer?.lines === 1 && typeof spacer.setLines === "function") spacer.setLines(0);
}

function decorate(
  component: AssistantLike,
  message: AssistantLike,
  streaming: boolean,
  theme: RenderTheme,
  repaint: () => void,
): void {
  const children = component.contentContainer?.children;
  if (!Array.isArray(children)) return;
  const runs = thinkingRuns(message);
  if (runs.length === 0) return;

  children.forEach(bindSpacer);
  const regions = children.filter(isHiddenThinking);
  const hoverStates = HOVERS.get(component) ?? [];
  HOVERS.set(component, hoverStates);
  const eraseStates = ERASES.get(component) ?? [];
  ERASES.set(component, eraseStates);
  const levelOf = (): DetailLevel => thinkingPlan(component)?.level ?? 0;
  const hasHiddenLabel = (component.hiddenThinkingLabel ?? "").trim() !== "";
  let runIndex = 0;
  let regionIndex = 0;
  const reasoningTokens = reportedReasoning(message, runs.length, streaming);
  for (const run of runs) {
    const isHidden = component.thinkingVisibilityOverrides?.get(runIndex) ?? component.hideThinkingBlock ?? false;
    // A hidden run with an empty label contributes no region at all.
    if (isHidden && !hasHiddenLabel) {
      runIndex += 1;
      continue;
    }
    const region = regions[regionIndex];
    regionIndex += 1;
    if (region) {
      const firstRun = regionIndex === 1;
      const foldOf = (): FoldPlan => {
        const plan = thinkingPlan(component) ?? NORMAL_PLAN;
        return !firstRun && plan.mode === "anchor" ? { ...plan, mode: "hidden" } : plan;
      };
      const hover = (hoverStates[runIndex] ??= { canToggle: false });
      const erase = (eraseStates[runIndex] ??= {});
      if (region.piUiHover !== hover) {
        region.piUiHover = hover;
        bindHover(region, component, hover, foldOf);
        expandedRegions.set(region, (row) => !!hover.expanded && (foldOf().mode !== "anchor" || row > 0));
        hoveredRegions.set(region, () => hover.target === "thought");
      }
      // Keep our marker and body in both states; expanding must not hand the
      // run back to pi's bare markdown. The click stays owned by MouseRegion.
      const fold = foldOf();
      region.child = labelComponent(
        run,
        message,
        reasoningTokens,
        streaming,
        theme,
        hover,
        erase,
        repaint,
        component,
        levelOf,
        foldOf,
        !isHidden,
        regionIndex - 1,
      );
      if (fold.mode === "hidden") suppressThinkingSpacer(children, region);
    }
    runIndex += 1;
  }
}

function isAssistant(component: unknown): component is AssistantLike {
  const candidate = component as ContainerLike;
  return (
    typeof candidate.updateContent === "function" &&
    typeof candidate.contentContainer === "object" &&
    candidate.contentContainer !== null &&
    candidate.thinkingVisibilityOverrides instanceof Map
  );
}

const PATCHED = "__piUiThinking";

function patchInstance(component: AssistantLike, theme: RenderTheme, repaint: () => void): void {
  if ((component as Record<string, unknown>)[PATCHED]) return;
  const original = component.updateContent;
  if (typeof original !== "function") return;

  const render = component.render;
  if (render) {
    component.render = function (width) {
      WIDTHS.set(this, width);
      const rows = render.call(this, width);
      return paintFold(rows, theme, this);
    };
  }

  component.updateContent = function (message: AssistantLike, streaming?: boolean): void {
    const isStreaming = streaming ?? this.isStreaming ?? false;
    original.call(this, message, isStreaming);
    try {
      decorate(this, message, isStreaming, theme, repaint);
    } catch {
      // A shape change costs the decoration, never the message.
    }
  };
  Object.defineProperty(component, PATCHED, { value: true });
  // Components patched after their content was built still need this pass.
  const last = component.lastMessage;
  if (last) {
    try {
      decorate(component, last, component.isStreaming ?? false, theme, repaint);
      component.invalidate?.();
    } catch {
      // Native label remains.
    }
  }
}

function isToolComponent(component: unknown): component is ToolComponentLike {
  const candidate = component as { toolCallId?: unknown; toolName?: unknown; rendererState?: unknown };
  return (
    typeof candidate.toolCallId === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.rendererState === "object"
  );
}

const compactToolShells = new WeakSet<ToolComponentLike>();

/** Pi's self-render shell inserts a blank before its content and subtracts it during mouse dispatch. */
function compactToolMember(component: ToolComponentLike, key: string, theme: RenderTheme): void {
  const { render, handleMouse } = component;
  if (
    compactToolShells.has(component) ||
    typeof component.selfRenderHeight !== "number" ||
    typeof render !== "function" ||
    typeof handleMouse !== "function"
  )
    return;
  compactToolShells.add(component);
  let skippedSpacer = false;
  expandedRegions.set(
    component,
    (row) =>
      !!component.selfRenderContainer && insideExpanded(component.selfRenderContainer, row - (skippedSpacer ? 0 : 1)),
  );
  hoveredRegions.set(component, () => !!component.selfRenderContainer && insideHovered(component.selfRenderContainer));
  component.render = function (width) {
    WIDTHS.set(component, width);
    const lines = render.call(this, width);
    const plan = toolPlan(key);
    skippedSpacer = plan?.mode === "hidden" && plan.group?.open === true && lines[0] === "";
    return skippedSpacer ? lines.slice(1) : paintFold(lines, theme, component);
  };
  component.handleMouse = function (event) {
    if (!skippedSpacer && event.y === 0) {
      const hit = onSpacerMouse(event);
      if (hit) return hit;
    }
    return handleMouse.call(this, skippedSpacer ? { ...event, y: event.y + 1, height: event.height + 1 } : event);
  };
}

function isUserComponent(component: unknown): boolean {
  const candidate = component as { text?: unknown; markdownTheme?: unknown };
  return (
    typeof candidate.text === "string" &&
    typeof candidate.markdownTheme === "object" &&
    candidate.markdownTheme !== null
  );
}

function groupOf(unit: FoldUnit): LiveFoldGroup | undefined {
  return (unit.kind === "tool" ? toolPlan(unit.key) : thinkingPlan(unit.component))?.group;
}

/** The rows a backlog has: those still to leave, and those that left since it began. */
interface Backlog {
  rows: number;
  done: number;
}

/** The level a block shows once its frame completes: the next one, the one a backlog reached, or the fold. */
function reachedLevel(frame: DecayFrame, previous: number): number {
  if (frame.folding) return FOLD_LEVEL;
  return frame.backlog && frame.level !== undefined ? frame.level : detailFor(previous) + 1;
}

/**
 * Walk the TUI in visual order, then read the ladder backwards: each component
 * knows how many blocks follow it in its run. This is what restored transcripts
 * need — their thinking components are patched after the tool rows have already
 * rendered, so render order alone would make every thought look newest.
 */
function patchTree(
  root: TranscriptTui,
  theme: RenderTheme,
  liveToolEnds: ReadonlyMap<string, number>,
  distances: WeakMap<object, number>,
  /** Rows still to leave, counted on every walk; the backlog interval spreads them. */
  backlog: Backlog,
  commit: object | undefined,
  /** Called with the number of runs and of blocks in the current run, before any fade starts. */
  countBlocks: (runs: number, blocks: number) => void,
  frameMs: () => number,
  current?: object,
): object | undefined {
  const ordered: unknown[] = [];
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  let cursor = 0;
  while (cursor < queue.length) {
    const component = queue[cursor++];
    if (!component || seen.has(component)) continue;
    seen.add(component);
    bindSpacer(component);
    ordered.push(component);
    const children = (component as ContainerLike).children;
    if (Array.isArray(children)) queue.push(...children);
  }

  const history = offscreenHistory(root);
  // Visual order: the blocks the distance rule weighs, and the units among them.
  const blocks: PlanBlock[] = [];
  const owners: Array<FoldUnit | undefined> = [];
  for (const component of ordered) {
    if (isUserComponent(component)) {
      restyleUserMessage(component, theme);
      blocks.push({ kind: "user" });
      owners.push(undefined);
      continue;
    }
    if (isToolComponent(component)) {
      const key = component.toolCallId;
      blocks.push({ kind: "tool" });
      if (!key) {
        owners.push(undefined);
        continue;
      }
      const info = toolInfo(key);
      if (info) compactToolMember(component, key, theme);
      const meta = toolMeta(info?.name ?? component.toolName ?? "");
      const failed = info?.status === "error";
      const endedAt = component.result?.timestamp ?? liveToolEnds.get(key);
      owners.push({
        kind: "tool",
        key,
        component,
        count: 1,
        cls: meta.cls,
        tokens: info?.tokens,
        failed,
        endedAt,
        startedAt: endedAt !== undefined && info?.durationMs !== undefined ? endedAt - info.durationMs : undefined,
        activeMs: info?.durationMs,
        distance: 0,
        boundary: !info || info.pinned || info.status === "pending" || info.status === "running",
        invalidate: () => (component as { invalidate?: () => void }).invalidate?.(),
      });
      continue;
    }
    if (!isAssistant(component)) continue;
    const message = component.lastMessage;
    const thoughts = message ? thinkingRuns(message) : [];
    const runs = thoughts.length;
    // Prose keeps its own row and splits the run; only a thinking-only message
    // can become a member of a summary.
    const hasProse = (message?.content ?? []).some((entry) => entry.type === "text" && entry.text?.trim());
    // An assistant that only owns tool calls is the container for the tool
    // components below it, not a block in its own right.
    if (runs === 0 && !hasProse) continue;
    blocks.push(runs === 0 ? { kind: "prose" } : { kind: "thinking", count: runs, withProse: hasProse });
    const pinned =
      !thinkingPlan(component)?.group && [...(component.thinkingVisibilityOverrides?.values() ?? [])].includes(false);
    owners.push({
      kind: "thinking",
      key: "thinking",
      component,
      count: Math.max(1, runs),
      cls: "thinking",
      tokens: {
        outputTokens:
          reportedReasoning(message, runs, component.isStreaming) ??
          thoughts.reduce((sum, run) => sum + estimatedTokens(run.chars), 0),
        inputTokens: 0,
      },
      startedAt: message?.timestamp,
      endedAt:
        message?.timestamp !== undefined && message.durationMs !== undefined
          ? message.timestamp + message.durationMs
          : undefined,
      activeMs: thinkingMs(message, thoughts),
      distance: 0,
      boundary: !!component.isStreaming || runs === 0 || hasProse || pinned,
      invalidate: () => component.invalidate?.(),
    });
  }
  const runs = blocks.filter((block) => block.kind === "user").length;
  countBlocks(runs, blocks.length - 1 - blocks.findLastIndex((block) => block.kind === "user"));
  const units: FoldUnit[] = [];
  let startsRun = false;
  blockDistances(blocks).forEach((placed, index) => {
    startsRun ||= placed.startsRun;
    const unit = owners[index];
    if (!unit) return;
    units.push(unit);
    unit.distance = placed.distance;
    unit.currentRun = placed.currentRun;
    // A keyless tool is weighed but owns no row: the run starts at the next unit.
    if (startsRun) unit.startsRun = true;
    startsRun = false;
  });
  const repaint = new Set<object>();
  let committed: FoldUnit | undefined;
  // Visible blocks behind their target, in visual order: they step down one at a time.
  const waiting: FoldUnit[] = [];
  // Where each waiting block heads: its target, and as far as the blocks older than it allow.
  const targets = new Map<FoldUnit, { target: number; allowed: number }>();
  // Nothing overtakes an older block that is still on its way: a newer block of
  // the run goes no further than the distance an older one is held at.
  let cap = Infinity;
  for (const unit of units) {
    if (unit.startsRun) cap = Infinity;
    const target = Math.min(FOLD_DISTANCE, unit.distance);
    const previous = distances.get(unit.component);
    unit.distance = target;
    if (previous !== undefined && previous < target && !history.has(unit.component) && !unit.boundary) {
      const fading = fadeOf(unit.component);
      const allowed = Math.max(previous, Math.min(target, cap));
      if (commit === unit.component && fading) {
        // The step has run its course: this walk commits the level it reached. A
        // block that fell further behind meanwhile stays on its way, row by row.
        committed = unit;
        endFade(unit.component);
        repaint.add(unit.component);
        const reached = reachedLevel(fading, previous);
        unit.distance = detailFor(allowed) <= reached ? allowed : Math.max(previous, reached * BLOCKS_PER_STEP);
      } else if (fading || detailFor(target) !== detailFor(previous)) {
        // Mid-step, or a level to lose: it waits its turn at the level it shows.
        unit.distance = previous;
      }
      // Otherwise newer blocks leave the level as it is: nothing to animate or to wait for.
      if (unit.distance < target) {
        waiting.push(unit);
        targets.set(unit, { target, allowed });
        cap = Math.min(cap, unit.distance);
      }
    }
    distances.set(unit.component, unit.distance);
  }
  // A backlog: a visible block more than one level behind, or the blocks of a run
  // a user message ended. Its rows leave one at a time, without fade phases.
  const ended = (component: object): boolean =>
    units.find((unit) => unit.component === component)?.currentRun === false;
  const inBacklog = waiting.some(
    (unit) => detailFor(targets.get(unit)!.target) - detailFor(unit.distance) > 1 || unit.currentRun === false,
  );
  // A collapse that has run its course: the group now shows only its summary.
  if (commit && fadeOf(commit) && !units.some((unit) => unit.component === commit)) endFade(commit);
  const changed = planFolds(units, committed?.component, (group, shown) => {
    const rows = memberRows(group.members.filter((member) => shown.has(member.component)));
    // Offscreen, or nothing left to animate: the group collapses at once.
    if (rows === 0 || group.members.every((member) => history.has(member.component))) return;
    const frame = startFade(group, undefined, true, frameMs());
    frame.foldRows = rows;
    frame.shown = shown;
    frame.blocks = units.length;
    if (inBacklog || ended(group.anchor.component)) frame.backlog = true;
    group.open = true;
  });
  // Collapses in visual order; a group sits where its first member does.
  const collapses: LiveFoldGroup[] = [];
  for (const unit of units) {
    const group = groupOf(unit);
    if (group?.anchor.component === unit.component && fadeOf(group)) collapses.push(group);
  }
  // A fade in progress keeps the floor until it ends: nothing pre-empts it.
  let floor: object | undefined;
  if (current && current !== commit && fadeOf(current)) {
    const old = current as Partial<LiveFoldGroup>;
    if (waiting.some((unit) => unit.component === current) || collapses.includes(old as LiveFoldGroup)) {
      floor = current;
    } else if (old.members) {
      // The collapsing group gained or lost members: the group that replaced it
      // finishes the fading row, then lets the rest leave one at a time.
      const members = new Set(old.members.map((member) => member.component));
      const successor = units
        .map(groupOf)
        .find(
          (group) =>
            group &&
            !fadeOf(group) &&
            group.choice === undefined &&
            !group.forming &&
            group.members.some((member) => members.has(member.component)),
        );
      const frame = successor && moveFade(current, successor);
      if (successor && frame) {
        frame.foldRows = memberRows(successor.members.filter((member) => frame.shown?.has(member.component)));
        frame.removed = Math.min(frame.removed, Math.max(0, frame.foldRows - 1));
        frame.hurry = true;
        successor.open = true;
        for (const member of successor.members) changed.add(member.component);
        collapses.push(successor);
        floor = successor;
      }
    }
    if (floor === undefined) {
      endFade(current);
      repaint.add(current);
    }
  }
  // Otherwise the oldest block or collapse on its way takes the floor.
  if (floor === undefined) {
    for (const unit of units) {
      const group = groupOf(unit);
      if (group && collapses.includes(group)) floor = group;
      else if (waiting.includes(unit)) floor = unit.component;
      if (floor) break;
    }
  }
  // A fold or collapse in progress hurries when a backlog forms, new blocks arrive
  // mid-collapse or another collapse waits: the fading row finishes, then the rest
  // leave at the backlog's pace.
  const floorFrame = floor ? fadeOf(floor) : undefined;
  const collapsing = collapses.includes(floor as LiveFoldGroup);
  if (
    floorFrame &&
    !floorFrame.backlog &&
    (inBacklog || (collapsing && (units.length > (floorFrame.blocks ?? units.length) || collapses.length > 1)))
  )
    floorFrame.hurry = true;
  for (const unit of units) {
    if (unit.component === floor || !fadeOf(unit.component)) continue;
    endFade(unit.component);
    repaint.add(unit.component);
  }
  const head = waiting.find((unit) => unit.component === floor);
  const headFrame = head && fadeOf(head.component);
  if (head && !headFrame) {
    // A step is a level: the one after the last standalone level is the fold.
    const level = detailFor(head.distance);
    const goal = detailFor(targets.get(head)!.allowed);
    const folding = level + 1 === FOLD_LEVEL;
    const joins = goal >= FOLD_LEVEL && joinsOpenGroup(units, units.indexOf(head));
    const frame = startFade(
      head.component,
      head.kind === "tool" ? head.key : undefined,
      folding,
      frameMs(),
      folding && joins,
    );
    // In a backlog the block takes every level to its goal in one frame, one row per tick.
    if (inBacklog) Object.assign(frame, { backlog: true, level, goal, joins });
    repaint.add(head.component);
  } else if (head && headFrame?.backlog && headFrame.goal !== undefined) {
    // New blocks mid-backlog: the block on its way heads for its new goal.
    headFrame.goal = Math.max(headFrame.goal, detailFor(targets.get(head)!.allowed));
  }
  // The rows still to leave, held-back blocks counted to their targets: each waiting
  // block's levels and fold, and each collapse's listed rows.
  let rows = 0;
  for (const unit of waiting) {
    const frame = fadeOf(unit.component);
    if (frame?.folding && frame.foldRows > 0) rows += Math.max(1, frame.foldRows - frame.removed);
    else rows += backlogRows(detailFor(unit.distance), detailFor(targets.get(unit)!.target), !!frame?.joins);
  }
  for (const group of collapses) {
    const frame = fadeOf(group);
    if (frame) rows += Math.max(0, frame.foldRows - frame.removed);
  }
  backlog.rows = rows;
  // Once no backlog is on its way, the next one counts its rows from zero.
  if (!inBacklog && !fadeOf(floor ?? {})?.backlog) backlog.done = 0;

  for (const component of ordered) {
    if (!isAssistant(component)) continue;
    patchInstance(component, theme, () => (root as { requestRender?: () => void }).requestRender?.());
  }
  for (const component of repaint) changed.add(component);
  for (const component of changed) {
    (component as { invalidate?: () => void }).invalidate?.();
  }
  if (changed.size > 0) (root as { requestRender?: () => void }).requestRender?.();
  return floor;
}

/** A thinking member's cells in its group's columns: one row per run, read as its label renders it. */
function thinkingMemberCells(member: FoldMember): MemberCells[] {
  const component = member.component as AssistantLike;
  const message = component.lastMessage;
  const runs = message ? thinkingRuns(message) : [];
  if (!message || runs.length === 0) return [{ label: THINKING_LABEL }];
  const streaming = component.isStreaming ?? false;
  const reasoningTokens = reportedReasoning(message, runs.length, streaming);
  return runs.map((run) => {
    const timing = thinkingTime(message, run.first, streaming);
    return thoughtCells({
      ...timing,
      estimatedTokens: estimatedTokens(run.chars),
      reasoningTokens,
      phase: timing.running ? "thinking" : "aged",
      text: run.text,
    });
  });
}

/** Wire the decorator to the live TUI. Safe to call once at extension load. */
export function installThinkingRenderer(pi: ExtensionAPI): void {
  registerMemberCells("thinking", thinkingMemberCells);
  let tui: (TranscriptTui & { requestRender?: () => void }) | undefined;
  installThinkingClock(pi, () => tui?.requestRender?.());
  let theme: RenderTheme | undefined;
  let queued: ReturnType<typeof setTimeout> | undefined;
  // Removes the probe widget once it has handed over the TUI; a new session's probe must not lose it early.
  let unprobe: ReturnType<typeof setTimeout> | undefined;
  // Live tool components receive the execution event without its persisted result timestamp.
  const liveToolEnds = new Map<string, number>();

  const distances = new WeakMap<object, number>();
  const backlog: Backlog = { rows: 0, done: 0 };
  // The block whose fade is running. A tick touches only it; a finished step walks once.
  let fading: object | undefined;
  let decayTimer: ReturnType<typeof setTimeout> | undefined;
  // The average gap between new blocks in this run, as the planner counts them, sets how long a row takes to fade.
  let clock: PaceClock = {};
  let counted: { runs: number; blocks: number } | undefined;
  const frameMs = (): number => fadeDurationMs(clock.pace) / FADE_FRAMES;
  // A backlog spreads all its rows, those gone and those to go, over its total time.
  const backlogMs = (): number => backlogIntervalMs(backlog.done + backlog.rows, clock.pace);
  const delayOf = (frame: DecayFrame | undefined): number =>
    frame?.backlog ? backlogMs() : (frame?.frameMs ?? frameMs());
  /**
   * One backlog row: a standalone block steps down a level, or once past its
   * last standalone level folds one row; a collapsing group lists one row fewer.
   * Only this block changes, and its plan takes the level directly. The block is
   * rendered again at its last width, as the screen will paint it: a step that
   * drops no row takes the next one in the same tick, and a fold counts its rows.
   * Returns true when the frame is complete and the walk may commit it.
   */
  const stepBacklog = (component: object, frame: DecayFrame): boolean => {
    const block = component as { render?: (width: number) => string[]; invalidate?: () => void };
    const width = WIDTHS.get(component);
    const rows = (): number | undefined => {
      if (width === undefined || typeof block.render !== "function") return undefined;
      block.invalidate?.();
      return block.render(width).length;
    };
    if (!frame.folding && frame.level !== undefined && frame.goal !== undefined) {
      const before = rows();
      while (frame.level + 1 < FOLD_LEVEL) {
        frame.level += 1;
        stepPlanLevel(component, frame.key, frame.level as DetailLevel);
        distances.set(component, frame.level * BLOCKS_PER_STEP);
        if (frame.level >= frame.goal) return true;
        const after = rows();
        if (before === undefined || after === undefined || after < before) return false;
      }
      // The last standalone level: the fold comes next, in this same tick.
      frame.folding = true;
      frame.keepHeading = !!frame.joins;
    }
    if (frame.folding) rows();
    return advanceFade(frame);
  };
  const countBlocks = (runs: number, blocks: number): void => {
    // A user message starts a new run, and a new pace.
    if (counted && runs !== counted.runs) clock = {};
    else if (counted && blocks > counted.blocks) blocksArrived(clock, performance.now());
    counted = { runs, blocks };
  };
  const tick = (): void => {
    decayTimer = undefined;
    const frame = fading && fadeOf(fading);
    if (!fading) return;
    // The fade ended outside a walk (the user opened or closed a collapsing group): hand on the floor.
    if (!frame) {
      patch();
      return;
    }
    if (frame.backlog) {
      if (stepBacklog(fading, frame)) {
        backlog.done += 1;
        patch(fading);
        return;
      }
      backlog.done += 1;
      backlog.rows = Math.max(0, backlog.rows - 1);
    } else {
      if (advanceFade(frame)) {
        patch(fading);
        return;
      }
      // Hurried, a fold or collapse finishes the row that was fading; the rest leave at the backlog's pace.
      if (frame.hurry && frame.phase === 0) frame.backlog = true;
      // A fold's next row starts a new fade: it reads the current pace.
      else if (frame.phase === 0) frame.frameMs = frameMs();
    }
    (fading as { invalidate?: () => void }).invalidate?.();
    tui?.requestRender?.();
    decayTimer = setTimeout(tick, delayOf(frame));
  };
  const patch = (commit?: object): void => {
    if (!tui || !theme) return;
    try {
      const activeTheme = theme;
      decorateViewport(tui, {
        bar: (cell, hovered) => styleBarCell(activeTheme, cell, hovered),
      });
      const head = patchTree(tui, theme, liveToolEnds, distances, backlog, commit, countBlocks, frameMs, fading);
      if (head !== fading) {
        clearTimeout(decayTimer);
        decayTimer = undefined;
        fading = head;
      }
      if (fading && !decayTimer) decayTimer = setTimeout(tick, delayOf(fadeOf(fading)));
    } catch {
      // Keep pi's native label if the tree shape changed.
    }
  };

  const schedule = (): void => {
    if (queued) return;
    queued = setTimeout(() => {
      queued = undefined;
      patch();
    }, 0);
  };
  scheduleFold = schedule;

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    liveToolEnds.clear();
    if (tui || !ctx.hasUI || ctx.mode !== "tui") return;
    try {
      // The factory runs on the next render; the widget itself renders no rows.
      ctx.ui.setWidget(PROBE_WIDGET, (nextTui, nextTheme) => {
        tui = nextTui;
        theme = nextTheme as unknown as RenderTheme;
        clearTimeout(unprobe);
        unprobe = setTimeout(() => {
          unprobe = undefined;
          try {
            ctx.ui.setWidget(PROBE_WIDGET, undefined);
          } catch {
            // The widget may already be gone after a session replacement.
          }
        }, 250);
        schedule();
        return { render: () => [], invalidate: () => {} };
      });
    } catch {
      // No widget surface: native label remains.
    }
  });

  // A user message starts a new run: patch so older thoughts floor.
  pi.on("message_start", schedule);
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") patch();
    if (event.message.role === "toolResult") {
      liveToolEnds.set(event.message.toolCallId, event.message.timestamp);
      schedule();
    }
  });
  pi.on("tool_execution_start", schedule);
  pi.on("tool_execution_end", schedule);
  pi.on("turn_end", () => patch());
  pi.on("agent_settled", () => patch());
  pi.on("session_shutdown", () => {
    // Nothing runs against the old session: the next session_start probes the TUI again.
    clearTimeout(queued);
    queued = undefined;
    clearTimeout(unprobe);
    unprobe = undefined;
    tui = undefined;
    theme = undefined;
    clearTimeout(decayTimer);
    decayTimer = undefined;
    fading = undefined;
    backlog.rows = 0;
    backlog.done = 0;
    clock = {};
    counted = undefined;
    resetFades();
  });
}
