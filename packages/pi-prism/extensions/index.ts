/**
 * pi-prism in the real session: tool rows you can open, close and read all the way.
 *
 * The renderer slots are split so the header stays one row while the body grows:
 * `renderCall` owns the header (and the hover hint), `renderResult` owns the body.
 * A click on either toggles between the transcript's tail and the whole output,
 * and a move paints the action the click would take.
 */

import {
  MouseRegion,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolRendererResolver, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { FOLD_DISTANCE, bodyLinesFor, type DetailLevel } from "../render/detail.ts";
import { glyphsFor } from "../render/glyphs.ts";
import { groupSegments, renderGroupRow, type GroupSegment } from "../render/group-row.ts";
import type { RenderKit, RenderTheme } from "../render/kit.ts";
import { nonEmptyLineCount } from "../render/text.ts";
import { toolMeta } from "../render/tools.ts";
import { renderToolRow, type ToolRowInput, type ToolStatus } from "../render/tool-row.ts";
import { levelFor, registerAge, resetAge, runIndex, sequenceIndex, startRun } from "./age.ts";
import { claimHover, releaseHover } from "./hover.ts";
import { installThinkingRenderer } from "./thinking.ts";

/**
 * Duck-typed on purpose: pi ships several tui copies, so structural types beat
 * `instanceof`. Only the fields a row uses are declared.
 */
interface Theme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  style(text: string, options: { fg?: unknown; bg?: unknown; bold?: boolean }): string;
  colors: Record<string, unknown>;
}

interface ToolRenderContext<State = unknown, Args = unknown> {
  args: Args;
  toolCallId?: string;
  state: State;
  isPartial: boolean;
  isError: boolean;
  executionStarted: boolean;
  durationMs: number | undefined;
  invalidate: () => void;
}

const GLYPHS = glyphsFor("unicode");

/** pi-tui's primitives, injected so the renderer stays dependency-free. */
const KIT: RenderKit = {
  truncateToWidth,
  wrap: wrapTextWithAnsi,
  visibleWidth,
  component: (build) => ({
    render: build,
    invalidate: () => {},
  }),
};

/** Tool kinds pi-prism owns. Anything else keeps whatever renderer it already had. */
const OWNED = /^(read|ls|grep|find|write|edit|bash|web|fetch|mcp__.*)$/;

type Expansion = 0 | 1;

interface RowState {
  expansion: Expansion;
  hover: boolean;
  hoverTimer?: ReturnType<typeof setTimeout>;
  /** Run the block belongs to, and its position inside that run. */
  run?: number;
  runSeq?: number;
  /** Filled by the result slot: the header opens it on click. */
  output?: string;
}

function stateOf<TArgs>(ctx: ToolRenderContext<RowState, TArgs>): RowState {
  // `ctx.state` is pi's shared `rendererState` object: mutate it, never replace
  // it on the ephemeral context, or every render starts from scratch.
  const state = (ctx.state ??= {} as RowState);
  if (typeof state.expansion !== "number") {
    state.expansion = 0;
    state.hover = false;
  }
  return state;
}

/**
 * Recency is live session state, not a design-system fixture. Every tool call
 * gets a stable sequence number; older rows shed a line, and past the fold
 * distance they collapse into a group summary anchored at the oldest member.
 */
type AgeKey = string | RowState;
type RenderMode = "normal" | "hidden" | "anchor";

interface FoldGroup {
  anchor: BlockRecord;
  members: BlockRecord[];
  segments: GroupSegment[];
  durationMs: number;
}

interface BlockRecord {
  key: AgeKey;
  run: number;
  runSeq: number;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  error?: string;
  durationMs?: number;
  invalidate: () => void;
  mode?: RenderMode;
  group?: FoldGroup;
  groupSig?: string;
  expansion: Expansion;
  open: boolean;
  hoverSummary: boolean;
  hoverMember: boolean;
  hoverOwner?: object;
  hoverTimer?: ReturnType<typeof setTimeout>;
}

const records = new Map<AgeKey, BlockRecord>();
const pendingInvalidations = new Set<BlockRecord>();
let planDirty = true;
let invalidateScheduled = false;

/** Coalesce plan-driven repaints so a render never invalidates synchronously. */
function scheduleInvalidation(record: BlockRecord): void {
  pendingInvalidations.add(record);
  if (invalidateScheduled) return;
  invalidateScheduled = true;
  queueMicrotask(() => {
    invalidateScheduled = false;
    const pending = [...pendingInvalidations];
    pendingInvalidations.clear();
    for (const entry of pending) entry.invalidate();
  });
}

function groupSignature(group: FoldGroup): string {
  const segments = group.segments.map((segment) => `${segment.cls}:${segment.count}:${segment.failed ?? 0}`).join(",");
  return `${group.members.length}|${segments}|${Math.round(group.durationMs)}`;
}

/**
 * Fold the rows older than the fold distance into contiguous groups. Failures
 * keep their own rows and split a group, exactly like the design-system plan.
 */
function refreshPlan(): void {
  if (!planDirty) return;
  planDirty = false;
  const next = new Map<BlockRecord, { mode: RenderMode; group?: FoldGroup }>();
  let current: BlockRecord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const members = [...current];
    const anchor = members[0]!;
    const group: FoldGroup = {
      anchor,
      members,
      segments: groupSegments(
        members.map((member) => ({ cls: toolMeta(member.name).cls, failed: member.status === "error" })),
      ),
      durationMs: members.reduce((sum, member) => sum + (member.durationMs ?? 0), 0),
    };
    next.set(anchor, { mode: "anchor", group });
    for (const member of members.slice(1)) next.set(member, { mode: "hidden", group });
    current = [];
  };
  const activeRun = runIndex();
  const activeSeq = sequenceIndex();
  for (const record of records.values()) {
    const sameRun = record.run === activeRun;
    const distance = sameRun ? activeSeq - record.runSeq : Infinity;
    if (distance >= FOLD_DISTANCE && record.status !== "error") {
      current.push(record);
      continue;
    }
    flush();
    next.set(record, { mode: "normal" });
  }
  flush();

  const changed: BlockRecord[] = [];
  for (const record of records.values()) {
    const planned = next.get(record) ?? { mode: "normal" as const };
    const signature = planned.group ? groupSignature(planned.group) : "";
    if (record.mode !== planned.mode || record.groupSig !== signature) {
      record.mode = planned.mode;
      record.group = planned.group;
      record.groupSig = signature;
      changed.push(record);
    } else if (planned.group) {
      record.group = planned.group;
    }
  }
  for (const record of changed) scheduleInvalidation(record);
}

function syncRecord<TArgs>(
  ctx: ToolRenderContext<RowState, TArgs>,
  state: RowState,
  name: string,
  args: TArgs,
  output: string,
): BlockRecord {
  // Key on the tool call, not the component: pi may rebuild a tool component
  // on invalidate, and a fresh state would otherwise take a new sequence.
  const key: AgeKey = ctx.toolCallId ?? state;
  const status = statusOf(ctx, output);
  const error = status === "error" ? output : undefined;
  let record = records.get(key);
  if (!record) {
    const age = registerAge(ctx.invalidate);
    record = {
      key,
      run: age.run,
      runSeq: age.seq,
      name,
      args: (args ?? {}) as Record<string, unknown>,
      status,
      output,
      error,
      durationMs: ctx.durationMs,
      invalidate: ctx.invalidate,
      expansion: 0,
      open: false,
      hoverSummary: false,
      hoverMember: false,
    };
    records.set(key, record);
    planDirty = true;
  } else {
    record.invalidate = ctx.invalidate;
    if (
      record.name !== name ||
      record.status !== status ||
      record.output !== output ||
      record.error !== error ||
      record.durationMs !== ctx.durationMs
    ) {
      planDirty = true;
    }
  }
  record.name = name;
  record.args = (args ?? {}) as Record<string, unknown>;
  record.status = status;
  record.output = output;
  record.error = error;
  record.durationMs = ctx.durationMs;
  state.run = record.run;
  state.runSeq = record.runSeq;
  refreshPlan();
  return record;
}

/** The newest block is level 0; each block behind it drops one body row. */
function levelOf(state: RowState): DetailLevel {
  if (state.runSeq === undefined || state.run === undefined) return 0;
  return levelFor(state.run, state.runSeq);
}

function statusOf<TArgs>(ctx: ToolRenderContext<RowState, TArgs>, output: string): ToolStatus {
  if (ctx.durationMs !== undefined) return ctx.isError ? "error" : "success";
  if (ctx.isPartial) return "running";
  return output ? "success" : ctx.executionStarted ? "running" : "pending";
}

function outputText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/**
 * The click must change something. A row that already shows its whole body has
 * no expand step; collapsing always has one. `null` means the row is inert.
 */
export function actionFor(expansion: Expansion, present: number, level: DetailLevel = 0): Expansion | null {
  if (expansion === 1) return 0;
  return present > bodyLinesFor(level) ? 1 : null;
}

/** What the next click does, in the row's own terms; nothing if nothing changes. */
export function hintFor(expansion: Expansion, present: number, level: DetailLevel = 0): string | null {
  const action = actionFor(expansion, present, level);
  if (action === null) return null;
  return action === 0 ? "click · collapse" : "click · expand";
}

/**
 * Tie a background to the text itself. Styling the whole line would paint the
 * empty remainder of the row, so the band is reopened per text run and closed
 * with a background-only reset (\x1b[49m) which leaves colour and weight alone.
 */
function tintText(theme: Theme, token: string, line: string): string {
  // oxlint-disable-next-line no-control-regex -- escape sequences are the input domain
  const open = /^\x1b\[[0-9;]*m/.exec(theme.bg(token, ""))?.[0];
  if (!open) return line;
  // oxlint-disable-next-line no-control-regex -- splitting styled runs from SGR codes
  return line.replace(/(\x1b\[[0-9;]*m)|([^\x1b]+)/g, (run, sgr: string | undefined, text: string | undefined) => {
    if (sgr) return sgr;
    if (!text || text.trim() === "") return text ?? "";
    return `${open}${text}\x1b[49m`;
  });
}

/** Streaming paint: the glyph moves while the tool still reports partial results. */
function frame(): number {
  return Math.floor(Date.now() / 100) % GLYPHS.spinner.length;
}

function inputFor<TArgs>(
  name: string,
  args: TArgs,
  ctx: ToolRenderContext<RowState, TArgs>,
  output: string,
): ToolRowInput {
  const state = stateOf(ctx);
  const status = statusOf(ctx, output);
  return {
    name,
    args: (args ?? {}) as Record<string, unknown>,
    status,
    level: levelOf(state),
    expanded: state.expansion === 1,
    full: state.expansion === 1,
    output,
    error: status === "error" ? output : undefined,
    durationMs: ctx.durationMs,
    frame: frame(),
  };
}

/**
 * Hover is explicit because terminals do not send a "left the row" event: a move
 * lights the row, and a short timer clears it when the pointer stops reporting.
 */
function claimRowHover<TArgs>(ctx: ToolRenderContext<RowState, TArgs>): RowState {
  const state = stateOf(ctx);
  claimHover(state, () => {
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverTimer = undefined;
    state.hover = false;
    ctx.invalidate();
  });
  return state;
}

function onMouse<TArgs>(ctx: ToolRenderContext<RowState, TArgs>, event: TuiMouseEvent) {
  const state = stateOf(ctx);
  if (event.type === "move") {
    const changed = !state.hover;
    state.hover = true;
    claimRowHover(ctx);
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => {
      state.hover = false;
      releaseHover(state);
      ctx.invalidate();
    }, 1200);
    if (changed) ctx.invalidate();
    return { render: true } as const;
  }
  if (event.type === "click" && event.button === "left") {
    const action = actionFor(state.expansion, nonEmptyLineCount(state.output ?? ""), levelOf(state));
    if (action === null) return undefined;
    state.expansion = action;
    state.hover = true;
    claimRowHover(ctx);
    ctx.invalidate();
    return { handled: true, render: true } as const;
  }
  return undefined;
}

function region<TArgs>(inner: Component, ctx: ToolRenderContext<RowState, TArgs>): Component {
  return new MouseRegion(inner, (event) => onMouse(ctx, event));
}

function emptyComponent(): Component {
  return KIT.component(() => []) as Component;
}

/** Right-aligned terminal chip, never wider than the row. */
function withChip(theme: Theme, line: string, hint: string, width: number): string {
  const chip = theme.style(`[ ${hint} ]`, {
    bg: theme.colors.accent,
    fg: theme.colors.toolPendingBg,
    bold: true,
  });
  const chipWidth = visibleWidth(chip);
  const left = truncateToWidth(line, Math.max(0, width - chipWidth - 1), "…");
  const gap = Math.max(0, width - visibleWidth(left) - chipWidth);
  return left + " ".repeat(gap) + chip;
}

/** Header row plus the hover chip, right-aligned, never wider than the terminal. */
function headerLines<TArgs>(
  name: string,
  args: TArgs,
  ctx: ToolRenderContext<RowState, TArgs>,
  theme: Theme,
  width: number,
): string[] {
  const state = stateOf(ctx);
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  const line = renderToolRow(api, inputFor(name, args, ctx, state.output ?? "")).render(width)[0] ?? "";
  if (!state.hover) return [line];
  // Keep hover neutral, like a thinking row: the chip is the affordance, not
  // another outcome signal competing with the status glyph.
  const header = tintText(theme, "toolPendingBg", line);
  const hint = hintFor(state.expansion, nonEmptyLineCount(state.output ?? ""), levelOf(state));
  return [hint === null ? header : withChip(theme, header, hint, width)];
}

function headerComponent<TArgs>(
  name: string,
  args: TArgs,
  ctx: ToolRenderContext<RowState, TArgs>,
  theme: Theme,
): Component {
  const inner = KIT.component((width) => headerLines(name, args, ctx, theme, width)) as Component;
  return region(inner, ctx);
}

function bodyComponent<TArgs>(
  name: string,
  args: TArgs,
  ctx: ToolRenderContext<RowState, TArgs>,
  theme: Theme,
  output: string,
): Component {
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  const inner = KIT.component((width) => {
    const lines = renderToolRow(api, inputFor(name, args, ctx, output)).render(width);
    return lines.slice(1);
  }) as Component;
  return region(inner, ctx);
}

type MemberHit = { start: number; end: number; member: BlockRecord };

function memberHint(member: BlockRecord): string | null {
  const present = nonEmptyLineCount(member.output);
  if (present === 0) return null;
  return member.expansion === 0 ? "click · expand" : "click · collapse";
}

function cycleMember(member: BlockRecord): void {
  if (nonEmptyLineCount(member.output) === 0) return;
  member.expansion = member.expansion === 1 ? 0 : 1;
}

function memberLines(member: BlockRecord, theme: Theme, width: number): string[] {
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  const rows = renderToolRow(api, {
    name: member.name,
    args: member.args,
    status: member.status,
    level: 0,
    expanded: member.expansion === 1,
    full: member.expansion === 1,
    output: member.output,
    error: member.error,
    durationMs: member.durationMs,
    frame: frame(),
  }).render(width);
  return member.expansion === 0 ? [rows[0] ?? ""] : rows;
}

function groupLines(record: BlockRecord, theme: Theme, width: number, hits: MemberHit[]): string[] {
  const group = record.group;
  if (!group) return [];
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  hits.length = 0;
  const summary =
    renderGroupRow(api, {
      segments: group.segments,
      expanded: record.open,
      durationMs: group.durationMs,
    }).render(width)[0] ?? "";
  const summaryHint = record.open ? "click · collapse" : "click · expand";
  const summaryLine = record.hoverSummary
    ? withChip(theme, tintText(theme, "toolPendingBg", summary), summaryHint, width)
    : summary;
  if (!record.open) return [summaryLine];

  const lines = [summaryLine];
  const memberWidth = Math.max(1, width - 2);
  for (const member of group.members) {
    const start = lines.length;
    const rows = memberLines(member, theme, memberWidth);
    const hint = member.hoverMember ? memberHint(member) : null;
    const header = member.hoverMember ? tintText(theme, "toolPendingBg", rows[0] ?? "") : (rows[0] ?? "");
    rows[0] = hint === null ? header : withChip(theme, header, hint, memberWidth);
    for (const row of rows) lines.push(`  ${row}`);
    hits.push({ start, end: lines.length, member });
  }
  return lines;
}

function onGroupMouse(record: BlockRecord, event: TuiMouseEvent, hits: MemberHit[]) {
  const group = record.group;
  if (!group) return undefined;
  const clearGroup = () => {
    record.hoverSummary = false;
    for (const member of group.members) member.hoverMember = false;
  };
  const settle = () => {
    if (record.hoverTimer) clearTimeout(record.hoverTimer);
    record.hoverTimer = undefined;
    clearGroup();
    record.invalidate();
  };
  const show = (owner: object, set: () => void, touch: boolean) => {
    // Clear this group before re-lighting the row under the pointer.
    clearGroup();
    claimHover(owner, () => {
      if (record.hoverOwner === owner) record.hoverOwner = undefined;
      settle();
    });
    record.hoverOwner = owner;
    set();
    if (record.hoverTimer) clearTimeout(record.hoverTimer);
    if (!touch) {
      record.hoverTimer = undefined;
      record.invalidate();
      return;
    }
    record.hoverTimer = setTimeout(() => {
      releaseHover(owner);
      if (record.hoverOwner === owner) record.hoverOwner = undefined;
      settle();
    }, 1200);
    record.invalidate();
  };
  const clearCurrent = () => {
    if (record.hoverOwner) releaseHover(record.hoverOwner);
    record.hoverOwner = undefined;
    settle();
  };

  if (event.type === "move") {
    if (event.y === 0 || !record.open) {
      show(
        record,
        () => {
          record.hoverSummary = true;
        },
        true,
      );
    } else {
      const hit = hits.find((entry) => event.y >= entry.start && event.y < entry.end);
      if (hit) {
        show(
          hit.member,
          () => {
            hit.member.hoverMember = true;
          },
          true,
        );
      } else clearCurrent();
    }
    return { render: true } as const;
  }

  if (event.type === "click" && event.button === "left") {
    if (!record.open || event.y === 0) {
      record.open = !record.open;
      show(
        record,
        () => {
          record.hoverSummary = true;
        },
        false,
      );
      return { handled: true, render: true } as const;
    }
    const hit = hits.find((entry) => event.y >= entry.start && event.y < entry.end);
    if (!hit) return undefined;
    cycleMember(hit.member);
    show(
      hit.member,
      () => {
        hit.member.hoverMember = true;
      },
      false,
    );
    return { handled: true, render: true } as const;
  }
  return undefined;
}

function groupComponent(record: BlockRecord, theme: Theme): Component {
  const hits: MemberHit[] = [];
  const inner: Component = {
    render: (width) => groupLines(record, theme, width, hits),
    invalidate: () => {},
  };
  return new MouseRegion(inner, (event) => onGroupMouse(record, event, hits));
}

const resolver: ToolRendererResolver = (toolName, next) => {
  if (!OWNED.test(toolName)) return next();
  return {
    renderShell: "self",
    renderCall: (args, theme, ctx) => {
      const renderCtx = ctx as ToolRenderContext<RowState, typeof args>;
      const state = stateOf(renderCtx);
      const record = syncRecord(renderCtx, state, toolName, args, state.output ?? "");
      if (record.mode === "hidden") return emptyComponent();
      if (record.mode === "anchor") return groupComponent(record, theme);
      return headerComponent(toolName, args, renderCtx, theme);
    },
    renderResult: (result, _options: ToolRenderResultOptions, theme, ctx) => {
      const renderCtx = ctx as ToolRenderContext<RowState, typeof ctx.args>;
      const state = stateOf(renderCtx);
      const output = outputText(result as { content: Array<{ type: string; text?: string }> });
      state.output = output;
      const record = syncRecord(renderCtx, state, toolName, renderCtx.args, output);
      if (record.mode === "hidden" || record.mode === "anchor") return emptyComponent();
      return bodyComponent(toolName, renderCtx.args, renderCtx, theme, output);
    },
  };
};

export default function prism(pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolver);
  installThinkingRenderer(pi);

  pi.on("session_start", () => {
    records.clear();
    pendingInvalidations.clear();
    resetAge();
    planDirty = true;
  });

  // A run is everything between user messages. A new user message ends the
  // previous run (it folds into summaries) and restarts the decay ladder;
  // assistant turns inside one run keep the same ladder.
  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    startRun();
    planDirty = true;
    refreshPlan();
  });
}
