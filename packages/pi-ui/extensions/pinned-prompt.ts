/**
 * The last prompt, pinned to the top of the transcript while it has scrolled out of view.
 *
 * pi's fullscreen layout is a stack of two: the transcript's scroll view, then the dock (pending
 * messages, widgets, editor, footer). A row added to the top of that stack belongs to neither — it
 * keeps its row while the transcript scrolls under it, which is what makes it sticky. The row
 * exists only while the user message it repeats has left the transcript's viewport, so the prompt
 * is never on screen twice: read back up to it, and the row is gone.
 *
 * Where the prompt sits is read from the layout's own scroll box: the content lines it already
 * rendered (`scrollContentLines`) hold the user message's rows, so the prompt's last row is found by
 * matching those rows against the component's own. No child is rendered twice for this, and no box
 * the transcript never builds is needed. The scroll view then says whether that row is above the
 * pane: following the end, above once it precedes the first visible row; scrolled back, when it
 * precedes the offset.
 *
 * Regular mode scrolls the terminal itself, where nothing can be pinned to the top of the screen;
 * there the row is left out rather than faked in the dock.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { glyphsFor } from "../render/glyphs.ts";
import type { RenderTheme } from "../render/kit.ts";
import { promptAboveViewport, renderPinnedPrompt } from "../render/pinned-prompt.ts";
import { KIT } from "./kit.ts";

const GLYPHS = glyphsFor("unicode");
/** A widget that renders no rows, only to learn the TUI on the next frame. */
const PROBE_WIDGET = "pi-ui-prompt-probe";

interface ScrollViewLike {
  contentHeight?: number;
  viewportHeight?: number;
  scrollTop?: number;
  isFollowingEnd?: boolean;
  getContentWidth?: (width: number) => number;
}

interface LayoutBox {
  component?: unknown;
  children?: LayoutBox[];
  scrollView?: ScrollViewLike;
  scrollContentLines?: readonly string[];
}

interface Stack {
  children?: unknown[];
  entries?: { component?: unknown; visible?: (viewport: { width: number; height: number }) => boolean }[];
}

interface TranscriptTui {
  mode?: string;
  currentLayout?: { root?: LayoutBox };
  getPrimaryScrollView?: () => ScrollViewLike | undefined;
  requestRender?: () => void;
}

interface Renderable {
  render: (width: number) => string[];
}

let tui: TranscriptTui | undefined;
let theme: RenderTheme | undefined;
let prompt = "";
/** The user message the transcript walk drew last: the newest prompt in visual order. */
let promptComponent: unknown;
/** Whether the last layout pass asked for the row. */
let shown = false;

/** The deepest box a search will visit, so a pathological tree cannot cost a frame. */
const SEARCH_LIMIT = 4000;

/** Record the user message the transcript walk drew last. */
export function notePromptComponent(component: unknown): void {
  promptComponent = component;
}

function findScrollBox(box: LayoutBox): LayoutBox | undefined {
  const queue: LayoutBox[] = [box];
  let seen = 0;
  while (queue.length && seen++ < SEARCH_LIMIT) {
    const next = queue.shift() as LayoutBox;
    if (next.scrollView) return next;
    if (next.children) queue.push(...next.children);
  }
  return undefined;
}

/**
 * The last content row the prompt occupies, 0-based, or -1 when it is not in the content. The
 * prompt's own rows are matched against the transcript's rendered lines, newest match first, so a
 * repeated prompt still finds the message that was just drawn.
 */
export function promptEndRow(content: readonly string[], promptLines: readonly string[]): number {
  const rows = promptLines.length;
  if (rows === 0 || content.length < rows) return -1;
  for (let index = content.length - rows; index >= 0; index -= 1) {
    let matches = true;
    for (let offset = 0; offset < rows && matches; offset += 1) {
      if (content[index + offset] !== promptLines[offset]) matches = false;
    }
    if (matches) return index + rows - 1;
  }
  return -1;
}

/** Whether the prompt's last row sits above the transcript's first visible one. */
function promptAbove(width: number): boolean {
  const scroll = tui?.getPrimaryScrollView?.();
  const box = tui?.currentLayout?.root ? findScrollBox(tui.currentLayout.root) : undefined;
  const content = box?.scrollContentLines;
  if (!scroll || !content || !promptComponent) return false;
  const contentWidth = scroll.getContentWidth?.(width) ?? width;
  const render = (promptComponent as Partial<Renderable>).render;
  const lines = typeof render === "function" ? render.call(promptComponent, contentWidth) : [];
  return promptAboveViewport({
    viewportHeight: scroll.viewportHeight ?? 0,
    contentHeight: scroll.contentHeight ?? 0,
    scrollTop: scroll.scrollTop ?? 0,
    followingEnd: scroll.isFollowingEnd !== false,
    promptEndRow: promptEndRow(content, lines),
  });
}

/** The pinned row: drawn only while the prompt is out of view above the transcript. */
const row = {
  render: (width: number): string[] => {
    if (!shown || !theme || !prompt) return [];
    return renderPinnedPrompt({ kit: KIT, theme, glyphs: GLYPHS }, { text: prompt, width });
  },
  invalidate: (): void => {},
};

/**
 * Put the row at the top of the layout stack; repeats only confirm it is still there. The root is
 * rebuilt when a session replaces another or the mode toggles, so this looks every time rather
 * than trusting a flag: a stack that is not there yet is simply tried again on the next event.
 */
function ensureRow(host: TranscriptTui): void {
  const screen = host.currentLayout?.root;
  const scroll = screen ? findScrollBox(screen) : undefined;
  const root = screen?.component as Stack | undefined;
  const entries = root?.entries;
  if (!scroll || !entries || !root?.children) return;
  if (entries.some((entry) => entry.component === row)) return;
  const at = entries.findIndex((entry) => entry.component === scroll.component);
  if (at < 0) return;
  root.children.splice(at, 0, row);
  entries.splice(at, 0, {
    component: row,
    visible: (viewport) => {
      shown = promptAbove(viewport.width);
      return shown;
    },
  });
  host.requestRender?.();
}

/** A prompt's text blocks, in order: what the pinned row repeats. */
function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      (block as { type?: string; text?: string }).type === "text" ? ((block as { text?: string }).text ?? "") : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** The newest user message on the active branch, so a resumed session keeps its row. */
function lastPrompt(ctx: ExtensionContext): string {
  type Entry = { type?: string; message?: { role?: string; content?: unknown } };
  const manager = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager;
  const branch = (manager?.getBranch?.() ?? []) as Entry[];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message?.role === "user") return promptText(entry.message.content);
  }
  return "";
}

function repaint(): void {
  tui?.requestRender?.();
}

/** A structural event: the row still belongs to whatever stack is now on screen. */
function attachRow(ctx?: ExtensionContext): void {
  // `ctx.ui.theme` is a live getter: a theme switched while idle repaints the band on this event.
  const current = (ctx as { ui?: { theme?: unknown } } | undefined)?.ui?.theme;
  if (current) theme = current as RenderTheme;
  if (tui) ensureRow(tui);
}

export function installPinnedPrompt(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    prompt = lastPrompt(ctx);
    try {
      // The factory runs on the next frame, which is where the TUI comes from; the layout root is
      // not built yet, so the probe takes its own empty render — it paints every frame — to look
      // for the stack until it finds one. A resumed session fires no structural event to re-assert
      // on, and a session replaced or a mode toggled rebuilds the root under the same probe.
      ctx.ui.setWidget(PROBE_WIDGET, (nextTui) => {
        tui = nextTui as unknown as TranscriptTui;
        theme = ctx.ui.theme as unknown as RenderTheme;
        repaint();
        return {
          render: () => {
            if (tui) ensureRow(tui);
            return [];
          },
          invalidate: () => {},
        };
      });
    } catch {
      // No widget surface: the transcript keeps pi's own rows.
    }
  });

  // A prompt is the newest user message: a steer included, since it is the last thing asked.
  pi.on("message_start", (event) => {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "user") return;
    prompt = promptText(message.content);
    promptComponent = undefined;
    if (tui) ensureRow(tui);
    repaint();
  });

  // /tree moves the branch: the prompt is whatever it now ends with.
  pi.on("session_tree", (_event, ctx: ExtensionContext) => {
    prompt = lastPrompt(ctx);
    promptComponent = undefined;
    repaint();
  });

  // Structural events after the first frame: the layout root may have been rebuilt (a session
  // replaced, fullscreen toggled), and the row belongs to the new stack.
  pi.on("turn_end", (_event, ctx: ExtensionContext) => attachRow(ctx));
  pi.on("agent_settled", (_event, ctx: ExtensionContext) => attachRow(ctx));

  pi.on("session_shutdown", () => {
    tui = undefined;
    theme = undefined;
    prompt = "";
    promptComponent = undefined;
    shown = false;
  });
}
