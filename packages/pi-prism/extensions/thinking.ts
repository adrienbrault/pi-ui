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
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOLD_DISTANCE, type DetailLevel } from "../render/detail.ts";
import { glyphsFor } from "../render/glyphs.ts";
import { renderGroupRow } from "../render/group-row.ts";
import type { RenderKit, RenderTheme } from "../render/kit.ts";
import { thinkingLabel } from "../render/thinking.ts";
import { claimHover, releaseHover } from "./hover.ts";

const GLYPHS = glyphsFor("unicode");
const KIT: RenderKit = {
  truncateToWidth,
  wrap: wrapTextWithAnsi,
  visibleWidth,
  component: (build) => ({ render: build, invalidate: () => {} }),
};

const PROBE_WIDGET = "pi-prism-thinking-probe";

interface ContentEntry {
  type: string;
  thinking?: string;
}

interface AssistantLike {
  content?: ContentEntry[];
  contentContainer?: { children?: unknown[] };
  thinkingVisibilityOverrides?: Map<number, boolean>;
  hideThinkingBlock?: boolean;
  hiddenThinkingLabel?: string;
  isStreaming?: boolean;
  outputPad?: number;
  updateContent?: (message: AssistantLike, streaming?: boolean) => void;
  lastMessage?: AssistantLike;
  invalidate?: () => void;
}

interface MouseEventLike {
  type?: string;
}

interface HoverState {
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface HiddenThinkingRegion {
  child: unknown;
  onMouse: (event: MouseEventLike) => unknown;
  prismHover?: HoverState;
}

/** One hover state per thinking run, so a rebuilt region does not reset it. */
const HOVERS = new WeakMap<object, HoverState[]>();

/** The decay level patchTree assigns from the component's place in the tree. */
const LEVELS = new WeakMap<object, DetailLevel>();

interface FoldState {
  kind: "normal" | "hidden" | "anchor";
  count?: number;
}

/** Old thinking runs fold into one summary; patchTree assigns the part. */
const FOLDS = new WeakMap<object, FoldState>();
const NORMAL_FOLD: FoldState = { kind: "normal" };

interface ContainerLike {
  children?: unknown[];
  updateContent?: unknown;
  contentContainer?: unknown;
  thinkingVisibilityOverrides?: unknown;
}

function thinkingRuns(message: AssistantLike): string[] {
  const content = message.content ?? [];
  const runs: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index]?.type !== "thinking") continue;
    const blocks: string[] = [];
    for (; index < content.length; index += 1) {
      const entry = content[index];
      if (entry?.type !== "thinking") break;
      const text = entry.thinking?.trim();
      if (text) blocks.push(text);
    }
    index -= 1;
    if (blocks.length > 0) runs.push(blocks.join("\n\n"));
  }
  return runs;
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

/** Right-aligned terminal chip, never wider than the row. */
function chipLine(theme: RenderTheme, line: string, hint: string, width: number): string {
  const accent = theme.colors?.accent;
  const fg = theme.colors?.toolPendingBg;
  if (!accent || !fg) return line;
  const chip = theme.style(`[ ${hint} ]`, { bg: accent, fg, bold: true });
  const chipWidth = visibleWidth(chip);
  const left = truncateToWidth(line, Math.max(0, width - chipWidth - 1), "…");
  const gap = Math.max(0, width - visibleWidth(left) - chipWidth);
  return left + " ".repeat(gap) + chip;
}

/** Tie a background to the text itself: no band across the empty row remainder. */
function tintText(theme: RenderTheme, token: string, line: string): string {
  const painted = theme.colors?.[token];
  if (!painted) return line;
  // oxlint-disable-next-line no-control-regex -- escape sequences are the input domain
  const open = /^\x1b\[[0-9;]*m/.exec(theme.style("", { bg: painted }))?.[0];
  if (!open) return line;
  // oxlint-disable-next-line no-control-regex -- splitting styled runs from SGR codes
  return line.replace(/(\x1b\[[0-9;]*m)|([^\x1b]+)/g, (run, sgr: string | undefined, text: string | undefined) => {
    if (sgr) return sgr;
    if (!text || text.trim() === "") return text ?? "";
    return `${open}${text}\x1b[49m`;
  });
}

function bindHover(region: HiddenThinkingRegion, component: AssistantLike, state: HoverState): void {
  const original = region.onMouse;
  const clear = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.active = false;
    component.invalidate?.();
  };
  region.onMouse = (event: MouseEventLike) => {
    let firstMove = false;
    if (event.type === "move") {
      firstMove = !state.active;
      state.active = true;
      claimHover(state, clear);
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.active = false;
        state.timer = undefined;
        releaseHover(state);
        component.invalidate?.();
      }, 1200);
      if (firstMove) component.invalidate?.();
    } else if (event.type === "click") {
      claimHover(state, clear);
      clear();
      releaseHover(state);
    }
    const result = original.call(region, event);
    // The dispatch layer repaints only when a handler asks for it.
    return firstMove ? (result ?? { render: true }) : result;
  };
}

function labelComponent(
  text: string,
  streaming: boolean,
  theme: RenderTheme,
  hover: HoverState,
  levelOf: () => DetailLevel,
  foldOf: () => FoldState,
  expanded: boolean,
): Component {
  return {
    render(width: number): string[] {
      const fold = foldOf();
      if (fold.kind === "hidden") return [];
      if (fold.kind === "anchor") {
        return renderGroupRow(
          { kit: KIT, theme, glyphs: GLYPHS },
          { segments: [{ cls: "thinking", count: fold.count ?? 1 }] },
        ).render(width);
      }
      const label = thinkingLabel(
        { kit: KIT, theme, glyphs: GLYPHS },
        {
          phase: streaming ? "thinking" : "aged",
          level: streaming ? 0 : levelOf(),
          text,
          width: Math.max(1, width),
          frame: Math.floor(Date.now() / 120),
          expanded,
        },
      );
      const lines = label.split("\n");
      if (!hover.active || lines.length === 0) return lines;
      const header = tintText(theme, "toolPendingBg", lines[0] ?? "");
      lines[0] = chipLine(theme, header, expanded ? "click · collapse" : "click · expand", width);
      return lines;
    },
    invalidate(): void {},
  };
}

function dropSpacerBefore(children: unknown[], region: unknown): void {
  const index = children.indexOf(region);
  if (index <= 0) return;
  const before = children[index - 1] as { lines?: unknown; render?: unknown; children?: unknown };
  if (
    before &&
    typeof before.lines === "number" &&
    typeof before.render === "function" &&
    !Array.isArray(before.children)
  ) {
    children.splice(index - 1, 1);
  }
}

function decorate(component: AssistantLike, message: AssistantLike, streaming: boolean, theme: RenderTheme): void {
  const children = component.contentContainer?.children;
  if (!Array.isArray(children)) return;
  const runs = thinkingRuns(message);
  if (runs.length === 0) return;

  const regions = children.filter(isHiddenThinking);
  const hoverStates = HOVERS.get(component) ?? [];
  HOVERS.set(component, hoverStates);
  const levelOf = (): DetailLevel => LEVELS.get(component) ?? 0;
  const foldOf = (): FoldState => FOLDS.get(component) ?? NORMAL_FOLD;
  const hasHiddenLabel = (component.hiddenThinkingLabel ?? "").trim() !== "";
  let runIndex = 0;
  let regionIndex = 0;
  for (const text of runs) {
    const isHidden = component.thinkingVisibilityOverrides?.get(runIndex) ?? component.hideThinkingBlock ?? false;
    // A hidden run with an empty label contributes no region at all.
    if (isHidden && !hasHiddenLabel) {
      runIndex += 1;
      continue;
    }
    const region = regions[regionIndex];
    regionIndex += 1;
    if (region) {
      const hover = (hoverStates[runIndex] ??= { active: false });
      if (region.prismHover !== hover) {
        region.prismHover = hover;
        bindHover(region, component, hover);
      }
      // Keep our marker and body in both states; expanding must not hand the
      // run back to pi's bare markdown. The click stays owned by MouseRegion.
      const fold = foldOf();
      region.child = labelComponent(text, streaming, theme, hover, levelOf, foldOf, !isHidden);
      // A hidden folded run should not leave its leading spacer behind.
      if (fold.kind === "hidden") dropSpacerBefore(children, region);
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

const PATCHED = "__prismThinking";

function patchInstance(component: AssistantLike, theme: RenderTheme): void {
  if ((component as Record<string, unknown>)[PATCHED]) return;
  const original = component.updateContent;
  if (typeof original !== "function") return;

  component.updateContent = function (message: AssistantLike, streaming?: boolean): void {
    const isStreaming = streaming ?? this.isStreaming ?? false;
    original.call(this, message, isStreaming);
    try {
      decorate(this, message, isStreaming, theme);
    } catch {
      // A shape change costs the decoration, never the message.
    }
  };
  Object.defineProperty(component, PATCHED, { value: true });
  // Components patched after their content was built still need this pass.
  const last = component.lastMessage;
  if (last) {
    try {
      decorate(component, last, component.isStreaming ?? false, theme);
      component.invalidate?.();
    } catch {
      // Native label remains.
    }
  }
}

function isToolComponent(component: unknown): boolean {
  const candidate = component as { toolCallId?: unknown; toolName?: unknown; rendererState?: unknown };
  return (
    typeof candidate.toolCallId === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.rendererState === "object"
  );
}

function isUserComponent(component: unknown): boolean {
  const candidate = component as { text?: unknown; markdownTheme?: unknown };
  return (
    typeof candidate.text === "string" &&
    typeof candidate.markdownTheme === "object" &&
    candidate.markdownTheme !== null
  );
}

/**
 * Walk the TUI in visual order, then read the ladder backwards: each component
 * knows how many blocks follow it in its run. This is what restored transcripts
 * need — their thinking components are patched after the tool rows have already
 * rendered, so render order alone would make every thought look newest.
 */
function patchTree(root: unknown, theme: RenderTheme): void {
  const ordered: unknown[] = [];
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  let cursor = 0;
  while (cursor < queue.length) {
    const component = queue[cursor++];
    if (!component || seen.has(component)) continue;
    seen.add(component);
    ordered.push(component);
    const children = (component as ContainerLike).children;
    if (Array.isArray(children)) queue.push(...children);
  }

  let behind = 0;
  const levels = new Map<unknown, DetailLevel>();
  const folded: Array<{ component: AssistantLike; index: number; count: number }> = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const component = ordered[index];
    if (isUserComponent(component)) {
      // Everything before a new user message belongs to an older run: floor it.
      behind = FOLD_DISTANCE;
      continue;
    }
    if (isToolComponent(component)) {
      behind += 1;
      continue;
    }
    if (!isAssistant(component)) continue;
    levels.set(component, Math.min(6, behind) as DetailLevel);
    const message = component.lastMessage;
    const runs = message ? thinkingRuns(message).length : 0;
    if (runs === 0) continue;
    if (behind >= FOLD_DISTANCE) folded.push({ component, index, count: runs });
    behind += 1;
  }

  folded.sort((left, right) => left.index - right.index);
  const folds = new Map<unknown, FoldState>();
  if (folded.length > 0) {
    const anchor = folded[0]?.component;
    const count = folded.reduce((sum, entry) => sum + entry.count, 0);
    for (const entry of folded) {
      folds.set(entry.component, entry.component === anchor ? { kind: "anchor", count } : { kind: "hidden" });
    }
  }

  for (const component of ordered) {
    if (!isAssistant(component)) continue;
    const next = levels.get(component) ?? 0;
    const nextFold = folds.get(component) ?? NORMAL_FOLD;
    const previous = LEVELS.get(component);
    const previousFold = FOLDS.get(component) ?? NORMAL_FOLD;
    LEVELS.set(component, next);
    FOLDS.set(component, nextFold);
    patchInstance(component, theme);
    if (previous !== next || previousFold.kind !== nextFold.kind || previousFold.count !== nextFold.count) {
      component.invalidate?.();
    }
  }
}

/** Wire the decorator to the live TUI. Safe to call once at extension load. */
export function installThinkingRenderer(pi: ExtensionAPI): void {
  let tui: unknown;
  let theme: RenderTheme | undefined;
  let queued = false;

  const patch = (): void => {
    if (!tui || !theme) return;
    try {
      patchTree(tui, theme);
    } catch {
      // Keep pi's native label if the tree shape changed.
    }
  };

  const schedule = (): void => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      patch();
    }, 0);
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (tui || !ctx.hasUI || ctx.mode !== "tui") return;
    try {
      // The factory runs on the next render; the widget itself renders no rows.
      ctx.ui.setWidget(PROBE_WIDGET, (nextTui, nextTheme) => {
        tui = nextTui;
        theme = nextTheme as unknown as RenderTheme;
        setTimeout(() => {
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
    // Restored transcripts can exist before the probe factory runs.
    setTimeout(patch, 100);
  });

  pi.on("message_start", () => {
    // A user message starts a new run: patch so older thoughts floor.
    schedule();
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") patch();
  });
  pi.on("turn_end", () => patch());
}
