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
  bold(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
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

/** Bodies long enough that one opening still hides rows deserve a second step. */
function hasDeeper(output: string): boolean {
  return nonEmptyLineCount(output) > 16;
}

/** What the next click does, in the row's own terms. */
export function hintFor(expansion: Expansion, deeper: boolean): string {
  if (expansion === 0) return "click · expand";
  if (expansion === 1) return deeper ? "click · show all" : "click · collapse";
  return "click · collapse";
}

/** Three states, wrapping: as shown → capped → whole body → as shown. */
export function nextExpansion(expansion: Expansion): Expansion {
  return ((expansion + 1) % 3) as Expansion;
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
    level: 0,
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
    state.expansion = nextExpansion(state.expansion);
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
  const header = renderToolRow(api, inputFor(name, args, ctx, state.output ?? "")).render(width)[0] ?? "";
  if (!state.hover) return [header];

  const hint = hintFor(state.expansion, hasDeeper(state.output ?? ""));
  const chip = theme.inverse(theme.bold(` ${hint} `));
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
      stateOf(renderCtx);
      return headerComponent(toolName, args, renderCtx, theme);
    },
    renderResult: (result, _options: ToolRenderResultOptions, theme, ctx) => {
      const renderCtx = ctx as ToolRenderContext<RowState, typeof ctx.args>;
      const state = stateOf(renderCtx);
      const output = outputText(result as { content: Array<{ type: string; text?: string }> });
      state.output = output;
      return bodyComponent(toolName, renderCtx.args, renderCtx, theme, output);
    },
  };
};

export default function prism(pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolver);
}
