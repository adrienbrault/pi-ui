/**
 * pi-prism in the real session: tool rows you can open, close and read all the way.
 *
 * The renderer slots are split so the header stays one row while the body grows:
 * `renderCall` owns the header (and the hover hint), `renderResult` owns the body.
 * A click on either cycles three states — as the transcript shows it, capped, and
 * the whole output — and a move paints the action the click would take.
 */

import { MouseRegion, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolRendererResolver, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { bodyLinesFor, detailFor, type DetailLevel } from "../render/detail.ts";
import { glyphsFor } from "../render/glyphs.ts";
import type { RenderKit, RenderTheme } from "../render/kit.ts";
import { nonEmptyLineCount } from "../render/text.ts";
import { renderToolRow, type ToolRowInput, type ToolStatus } from "../render/tool-row.ts";

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
  visibleWidth,
  component: (build) => ({
    render: build,
    invalidate: () => {},
  }),
};

/** Tool kinds pi-prism owns. Anything else keeps whatever renderer it already had. */
const OWNED = /^(read|ls|grep|find|write|edit|bash|web|fetch|mcp__.*)$/;

type Expansion = 0 | 1 | 2;

interface RowState {
  expansion: Expansion;
  hover: boolean;
  hoverTimer?: ReturnType<typeof setTimeout>;
  /** Position in the run; the newest block sits at `latestSeq`. */
  seq?: number;
  /** Filled by the result slot: "show all" only exists when rows stay hidden. */
  output?: string;
}

function stateOf<TArgs>(ctx: ToolRenderContext<RowState, TArgs>): RowState {
  const state = ctx.state as RowState | undefined;
  if (state && typeof state.expansion === "number") return state;
  const fresh: RowState = { expansion: 0, hover: false };
  ctx.state = fresh;
  return fresh;
}

/**
 * Recency is live session state, not a design-system fixture: every tool call
 * takes the next sequence number, and the blocks behind it are told to re-render
 * so they shed the row the newer block has earned.
 */
const aged: Array<{ seq: number; invalidate: () => void }> = [];
let latestSeq = 0;

function ageState<TArgs>(ctx: ToolRenderContext<RowState, TArgs>, state: RowState): void {
  if (state.seq !== undefined) return;
  state.seq = ++latestSeq;
  aged.push({ seq: state.seq, invalidate: ctx.invalidate });
  for (const row of aged) {
    if (row.seq < state.seq) row.invalidate();
  }
}

/** The newest block is level 0; each block behind it drops one body row. */
function levelOf(state: RowState): DetailLevel {
  return state.seq === undefined ? 0 : detailFor(latestSeq - state.seq);
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

const CAPPED = bodyLinesFor(0, true);

/**
 * The click must change something. A row that already shows its whole body has
 * no expand step; collapsing always has one. `null` means the row is inert.
 */
export function actionFor(expansion: Expansion, present: number, level: DetailLevel = 0): Expansion | null {
  if (expansion === 2) return 0;
  if (expansion === 1) return present > CAPPED ? 2 : 0;
  return present > bodyLinesFor(level) ? 1 : null;
}

/** What the next click does, in the row's own terms; nothing if nothing changes. */
export function hintFor(expansion: Expansion, present: number, level: DetailLevel = 0): string | null {
  const action = actionFor(expansion, present, level);
  if (action === null) return null;
  if (action === 0) return "click · collapse";
  return expansion === 0 ? "click · expand" : "click · show all";
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
    expanded: state.expansion >= 1,
    full: state.expansion >= 2,
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
function onMouse<TArgs>(ctx: ToolRenderContext<RowState, TArgs>, event: TuiMouseEvent) {
  const state = stateOf(ctx);
  if (event.type === "move") {
    if (!state.hover) {
      state.hover = true;
      ctx.invalidate();
    }
    if (state.hoverTimer) clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => {
      state.hover = false;
      ctx.invalidate();
    }, 1200);
    return { render: true } as const;
  }
  if (event.type === "click" && event.button === "left") {
    const action = actionFor(state.expansion, nonEmptyLineCount(state.output ?? ""), levelOf(state));
    if (action === null) return undefined;
    state.expansion = action;
    state.hover = true;
    ctx.invalidate();
    return { handled: true, render: true } as const;
  }
  return undefined;
}

function region<TArgs>(inner: Component, ctx: ToolRenderContext<RowState, TArgs>): Component {
  return new MouseRegion(inner, (event) => onMouse(ctx, event));
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
  // The header itself lights up, tinted by the outcome it reports.
  const tone =
    statusOf(ctx, state.output ?? "") === "error"
      ? "toolErrorBg"
      : statusOf(ctx, state.output ?? "") === "success"
        ? "toolSuccessBg"
        : "toolPendingBg";
  const header = tintText(theme, tone, line);

  const hint = hintFor(state.expansion, nonEmptyLineCount(state.output ?? ""), levelOf(state));
  if (hint === null) return [header];
  // Brackets and a background colour: the chip reads like the rest of the rows.
  const chip = theme.style(`[ ${hint} ]`, {
    bg: theme.colors.accent,
    fg: theme.colors.toolPendingBg,
    bold: true,
  });
  const chipWidth = visibleWidth(chip);
  const left = truncateToWidth(header, Math.max(0, width - chipWidth - 1), "…");
  const gap = Math.max(0, width - visibleWidth(left) - chipWidth);
  return [left + " ".repeat(gap) + chip];
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

const resolver: ToolRendererResolver = (toolName, next) => {
  if (!OWNED.test(toolName)) return next();
  return {
    renderShell: "self",
    renderCall: (args, theme, ctx) => {
      const renderCtx = ctx as ToolRenderContext<RowState, typeof args>;
      ageState(renderCtx, stateOf(renderCtx));
      return headerComponent(toolName, args, renderCtx, theme);
    },
    renderResult: (result, _options: ToolRenderResultOptions, theme, ctx) => {
      const renderCtx = ctx as ToolRenderContext<RowState, typeof ctx.args>;
      const state = stateOf(renderCtx);
      ageState(renderCtx, state);
      const output = outputText(result as { content: Array<{ type: string; text?: string }> });
      state.output = output;
      return bodyComponent(toolName, renderCtx.args, renderCtx, theme, output);
    },
  };
};

export default function prism(pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolver);
}
