/**
 * pi-prism in the real session: tool rows you can open, close and read all the way.
 *
 * The renderer slots are split so the header stays one row while the body grows:
 * `renderCall` owns the header, `renderResult` owns the body. Hovering a block
 * that can open paints its scroll bar in column 1; nothing else changes.
 */

import { MouseRegion, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  estimateTokens,
  type ExtensionAPI,
  type ToolRendererResolver,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { COMPACT_LEVEL, bodyLinesFor, type DetailLevel } from "../render/detail.ts";
import { glyphsFor } from "../render/glyphs.ts";
import { renderGroupMember, renderGroupRow } from "../render/group-row.ts";
import { installThroughput } from "./throughput.ts";
import { KIT } from "./kit.ts";
import { cutMark, type RenderTheme } from "../render/kit.ts";
import { callTokens, ownsTool, toolTokenCounts } from "../render/tools.ts";
import { nonEmptyLineCount } from "../render/text.ts";
import {
  previewText,
  leavingRow,
  toolHeader,
  toolLabel,
  toolRowCells,
  toolRowLayout,
  renderToolRow,
  type ToolRowInput,
  type ToolStatus,
} from "../render/tool-row.ts";
import type { MemberCells } from "../render/columns.ts";
import { groupColumns, registerMemberCells } from "./columns.ts";
import {
  type FoldMember,
  type FoldMode,
  keepGroupOpen,
  type LiveFoldGroup,
  memberRowFade,
  registerToolInfo,
  resetFolds,
  setGroupOpen,
  toolInfo,
  toolPlan,
} from "./fold.ts";
import { claimHover, releaseHover } from "./hover.ts";
import { expandedRegions, hoveredRegions, paintBar, paintBarCell, styleBarCell } from "./viewport.ts";
import { fadeLine, paintLeaving, toolFade } from "./fade.ts";
import { installThinkingRenderer, scheduleThinkingFold } from "./thinking.ts";

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

/** Tool kinds pi-prism owns. Anything else keeps whatever renderer it already had. */

type Expansion = 0 | 1;

interface BlockRecord {
  key: string | object;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  invalidate: () => void;
  mode?: FoldMode;
  group?: LiveFoldGroup;
  expansion: Expansion;
  commandClipped?: boolean;
  hoverSummary: boolean;
  hover: boolean;
  expandRow?: number;
  pinnedVisible: boolean;
  hoverTimer?: ReturnType<typeof setTimeout>;
}

const records = new Map<string | object, BlockRecord>();
let ratesFor: ReturnType<typeof installThroughput> | undefined;
const runningBash = new Map<string, { startedAt: number; timer: ReturnType<typeof setInterval> }>();

function stopBashClock(id: string): void {
  const clock = runningBash.get(id);
  if (!clock) return;
  clearInterval(clock.timer);
  runningBash.delete(id);
}

function clearBashClocks(): void {
  for (const id of runningBash.keys()) stopBashClock(id);
}

function publishToolInfo(record: BlockRecord): void {
  if (typeof record.key !== "string") return;
  const changed = registerToolInfo(record.key, {
    name: record.name,
    status: record.status,
    durationMs: record.durationMs,
    pinned: record.pinnedVisible,
    tokens: record.status === "success" || record.status === "error" ? toolTokenCounts(record) : undefined,
  });
  if (changed) scheduleThinkingFold();
}

function statusOf(ctx: ToolRenderContext): ToolStatus {
  if (ctx.isError) return "error";
  if (!ctx.isPartial) return "success";
  return ctx.executionStarted ? "running" : "pending";
}

function syncRecord<TArgs>(
  ctx: ToolRenderContext<object, TArgs>,
  name: string,
  args: TArgs,
  output?: string,
  inputTokens?: number,
): BlockRecord {
  const key = ctx.toolCallId ?? (ctx.state ??= {});
  let record = records.get(key);
  const status = statusOf(ctx);
  if (!record) {
    record = {
      key,
      name,
      status,
      args: {},
      output: "",
      invalidate: ctx.invalidate,
      expansion: 0,
      pinnedVisible: false,
      hover: false,
      hoverSummary: false,
    };
    records.set(key, record);
  }
  record.invalidate = ctx.invalidate;
  const nextArgs = (args ?? {}) as Record<string, unknown>;
  // Pending arguments may be filled in place. Reuse the count on later transcript repaints.
  if (
    status === "pending" ||
    record.status === "pending" ||
    nextArgs !== record.args ||
    record.outputTokens === undefined
  ) {
    record.outputTokens = callTokens(name, nextArgs);
  }
  record.args = nextArgs;
  record.name = name;
  record.status = status;
  if (output !== undefined) record.output = output;
  if (inputTokens !== undefined) record.inputTokens = inputTokens;
  record.error = status === "error" ? record.output : undefined;
  record.durationMs = ctx.durationMs;
  publishToolInfo(record);
  const planned = typeof key === "string" ? toolPlan(key) : undefined;
  record.mode = planned?.mode;
  record.group = planned?.group;
  return record;
}

function levelOf(record: BlockRecord): DetailLevel {
  return typeof record.key === "string" ? (toolPlan(record.key)?.level ?? 0) : 0;
}

function setExpansion(record: BlockRecord, expansion: Expansion): void {
  record.expansion = expansion;
  record.pinnedVisible = expansion === 1 && !record.group;
  publishToolInfo(record);
}

function outputText(
  name: string,
  isError: boolean,
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
): string {
  const details = result.details;
  if (name === "edit" && !isError && details && typeof details === "object") {
    if ("patch" in details && typeof details.patch === "string" && details.patch) return details.patch;
    if ("diff" in details && typeof details.diff === "string" && details.diff) return details.diff;
  }
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

/** Streaming paint: the glyph moves while the tool still reports partial results. */
function frame(): number {
  return Math.floor(Date.now() / 100) % GLYPHS.spinner.length;
}

function inputFor(record: BlockRecord): ToolRowInput {
  const clock = record.status === "running" && typeof record.key === "string" ? runningBash.get(record.key) : undefined;
  return {
    name: record.name,
    args: record.args,
    status: record.status,
    level: levelOf(record),
    expanded: record.expansion === 1,
    full: record.expansion === 1,
    output: record.output,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    ...(typeof record.key === "string" ? ratesFor?.(record.key) : undefined),
    error: record.error,
    durationMs: clock ? performance.now() - clock.startedAt : record.durationMs,
    frame: frame(),
  };
}

/**
 * Hover is explicit because terminals do not send a "left the row" event: a move
 * lights the row, and a short timer clears it when the pointer stops reporting.
 */
function claimRowHover(state: BlockRecord): void {
  claimHover(state, () => {
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverTimer = undefined;
    state.hover = false;
    state.invalidate();
  });
}

function onMouse(state: BlockRecord, event: TuiMouseEvent) {
  if (event.type === "move") {
    const changed = !state.hover;
    state.hover = true;
    claimRowHover(state);
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => {
      state.hover = false;
      releaseHover(state);
      state.invalidate();
    }, 1200);
    if (changed) state.invalidate();
    return { handled: true, render: true } as const;
  }
  if (event.type === "click" && event.button === "left") {
    setExpansion(state, state.expansion === 1 ? 0 : 1);
    state.hover = true;
    claimRowHover(state);
    state.invalidate();
    return { handled: true, render: true } as const;
  }
  return undefined;
}

function region(inner: Component, record: BlockRecord, part: "header" | "body" | "combined" = "header"): Component {
  const surface = new MouseRegion(inner, (event) => {
    if (
      event.type === "click" &&
      !record.expansion &&
      // Any row of a block that can open opens it.
      !(record.commandClipped || record.expandRow !== undefined)
    )
      return { handled: true, render: false };
    return onMouse(record, event);
  });
  if (part !== "header") {
    expandedRegions.set(surface, () => record.expansion === 1);
    hoveredRegions.set(surface, () => record.hover);
  }
  return surface;
}

function emptyComponent(): Component {
  return KIT.component(() => []) as Component;
}

function headerComponent(record: BlockRecord, theme: Theme): Component {
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  return region(
    KIT.component((width) => {
      const header = toolHeader(api, inputFor(record), width);
      record.commandClipped = !!header.hiddenCommand;
      // A clipped command with no output has no body rows to carry the bar: its header takes one filled cell.
      if (record.hover && !record.expansion && record.commandClipped && nonEmptyLineCount(previewText(record)) === 0)
        return [paintBarCell(header.line, styleBarCell(api.theme, "fill"), width)];
      return [header.line];
    }) as Component,
    record,
  );
}

function bodyComponent(record: BlockRecord, theme: Theme, includeHeader = false): Component {
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  return region(
    KIT.component((width) => {
      const input = inputFor(record);
      const layout = toolRowLayout({ ...api, owner: record }, input, width);
      let rows = layout.rows.slice(includeHeader ? 0 : 1);
      if (record.expansion === 1) return rows;
      // A step down fades the row the next level drops, found by the renderer.
      const fade = typeof record.key === "string" ? toolFade(record.key) : undefined;
      if (fade) {
        const leaving = leavingRow(api, input, width);
        rows = paintLeaving(
          rows,
          leaving === undefined ? undefined : leaving - (includeHeader ? 0 : 1),
          fade,
          api.theme,
        );
      }
      // The omission notice: above a tail, at the cut of a head-and-tail read, below a diff's evidence.
      // The renderer marks it as the body row with no source line, so output that reads like one is not.
      const sources = layout.sources ?? [];
      const notice = sources.indexOf(undefined);
      const omission = notice === -1 ? -1 : rows.length - sources.length + notice;
      const expandable =
        record.commandClipped ||
        omission !== -1 ||
        layout.clipped ||
        actionFor(record.expansion, nonEmptyLineCount(previewText(record)), levelOf(record)) !== null;
      record.expandRow = expandable && rows.length ? (omission === -1 ? rows.length - 1 : omission) : undefined;
      // Hover shows only the scroll bar: where the preview sits in the whole output.
      if (expandable && record.hover && layout.bar?.length)
        paintBar(rows, rows.length - layout.bar.length, layout.bar, (cell) => styleBarCell(api.theme, cell), width);
      return rows;
    }) as Component,
    record,
    includeHeader ? "combined" : "body",
  );
}

/** A member opens only when it has a body or a clipped command to show. */
function canCycle(member: BlockRecord): boolean {
  return !!member.commandClipped || nonEmptyLineCount(previewText(member)) > 0;
}

function cycleMember(member: BlockRecord): void {
  if (!canCycle(member)) return;
  setExpansion(member, member.expansion === 1 ? 0 : 1);
}

/** The anchor is also a member; its row sits under the summary once open. */
function memberLines(member: BlockRecord, theme: Theme, width: number): string[] {
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  const rows = renderGroupMember(
    KIT,
    width,
    (innerWidth) => {
      const input: ToolRowInput = {
        ...inputFor(member),
        level: COMPACT_LEVEL,
        ...(member.group ? { columns: groupColumns(member.group) } : {}),
      };
      if (member.expansion === 0) {
        const header = toolHeader(api, input, innerWidth);
        member.commandClipped = !!header.hiddenCommand;
        return [header.line];
      }
      return renderToolRow({ ...api, owner: member }, input).render(innerWidth);
    },
    cutMark(api.theme),
  );
  // A collapsing group drops its member rows from the bottom, one fade each.
  const collapse = member.group && typeof member.key === "string" ? memberRowFade(member.group, member.key) : undefined;
  if (collapse?.gone) return [];
  if (collapse?.phase) return rows.map((row) => fadeLine(row, collapse.phase, theme as unknown as RenderTheme));
  // Hover marks a member that can open with one filled bar cell on its row; an open member carries the open-block bar.
  if (member.hover && member.expansion === 0 && canCycle(member) && rows[0] !== undefined)
    rows[0] = paintBarCell(rows[0], styleBarCell(api.theme, "fill"), width);
  return rows;
}

function groupLines(record: BlockRecord, theme: Theme, width: number): string[] {
  const group = record.group;
  if (!group) return [];
  const api = { kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS };
  const summary =
    renderGroupRow(api, {
      segments: group.segments,
      tokens: group.tokens,
      expanded: group.open,
      ...(group.durationMs !== undefined ? { durationMs: group.durationMs } : {}),
    }).render(width)[0] ?? "";
  // Hover marks the summary with one filled bar cell: a click anywhere on it opens or closes the group.
  const rows = [record.hoverSummary ? paintBarCell(summary, styleBarCell(api.theme, "fill"), width) : summary];
  return group.open ? [...rows, ...memberLines(record, theme, width)] : rows;
}

function onGroupMouse(record: BlockRecord, event: TuiMouseEvent) {
  const group = record.group;
  if (!group) return undefined;
  const clear = () => {
    if (record.hoverTimer) clearTimeout(record.hoverTimer);
    record.hoverTimer = undefined;
    record.hoverSummary = false;
    record.hover = false;
    record.invalidate();
  };
  const show = (touch: boolean) => {
    claimHover(record, clear);
    if (record.hoverTimer) clearTimeout(record.hoverTimer);
    if (!touch) {
      record.hoverTimer = undefined;
      record.invalidate();
      return;
    }
    record.hoverTimer = setTimeout(() => {
      releaseHover(record);
      clear();
    }, 1200);
    record.invalidate();
  };

  if (event.type === "move") {
    const onMember = record.mode === "hidden" || (group.open && event.y > 0);
    record.hover = onMember;
    record.hoverSummary = !onMember;
    show(true);
    return { handled: true, render: true } as const;
  }
  if (event.type === "click" && event.button === "left") {
    // Rows below the summary belong to the anchor member, not the group.
    if (record.mode === "hidden" || (group.open && event.y > 0)) {
      cycleMember(record);
      // An opened member keeps a forming group from collapsing under it.
      if (record.expansion === 1) keepGroupOpen(group);
      record.hoverSummary = false;
      record.invalidate();
      return { handled: true, render: true } as const;
    }
    // Opening reveals the members in their own places; each member keeps its
    // own click for expanding its body.
    setGroupOpen(group, !group.open);
    record.hoverSummary = true;
    show(false);
    return { handled: true, render: true } as const;
  }
  return undefined;
}

function groupComponent(record: BlockRecord, theme: Theme): Component {
  const inner: Component = {
    render: (width) =>
      record.mode === "hidden" ? memberLines(record, theme, width) : groupLines(record, theme, width),
    invalidate: () => {},
  };
  const surface = new MouseRegion(inner, (event) => onGroupMouse(record, event));
  expandedRegions.set(surface, (row) => record.expansion === 1 && (record.mode === "hidden" || row > 0));
  hoveredRegions.set(surface, () => record.hover);
  return surface;
}

const resolver: ToolRendererResolver = (toolName, next) => {
  if (!ownsTool(toolName)) return next();
  return {
    renderShell: "self",
    renderCall: (args, theme, ctx) => {
      const record = syncRecord(ctx, toolName, args);
      if (record.mode === "hidden" && !record.group?.open) return emptyComponent();
      if (record.group) return groupComponent(record, theme);
      return toolName === "write" ? bodyComponent(record, theme, true) : headerComponent(record, theme);
    },
    renderResult: (result, _options: ToolRenderResultOptions, theme, ctx) => {
      const inputTokens = estimateTokens({
        role: "toolResult",
        toolName,
        toolCallId: ctx.toolCallId,
        isError: ctx.isError,
        timestamp: 0,
        content: result.content,
      });
      const record = syncRecord(ctx, toolName, ctx.args, outputText(toolName, ctx.isError, result), inputTokens);
      if (record.group || toolName === "write") return emptyComponent();
      return bodyComponent(record, theme);
    },
  };
};

/** A tool member's cells in its group's columns. */
function toolMemberCells(member: FoldMember): MemberCells[] {
  const record = records.get(member.key);
  if (record) return [toolRowCells(inputFor(record))];
  const name = toolInfo(member.key)?.name;
  return name === undefined ? [] : [{ label: toolLabel(name) }];
}

export default function prism(pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolver);
  registerMemberCells("tool", toolMemberCells);
  installThinkingRenderer(pi);
  ratesFor = installThroughput(pi, (id) => records.get(id)?.invalidate());

  pi.on("tool_execution_start", (event, ctx) => {
    const { toolCallId } = event;
    if (ctx.mode !== "tui" || event.toolName !== "bash" || event.parentToolCallId || runningBash.has(toolCallId))
      return;
    const startedAt = performance.now();
    const timer = setInterval(() => records.get(toolCallId)?.invalidate(), 100);
    runningBash.set(toolCallId, { startedAt, timer });
  });
  pi.on("tool_execution_end", (event) => stopBashClock(event.toolCallId));
  pi.on("session_shutdown", clearBashClocks);
  pi.on("session_start", () => {
    clearBashClocks();
    records.clear();
    resetFolds();
    scheduleThinkingFold();
  });
}
