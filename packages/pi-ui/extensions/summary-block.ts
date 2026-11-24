/**
 * pi's summary blocks, in pi-ui's rows.
 *
 * pi hands the transcript a `compactionSummary` (or `branchSummary`) message and draws it as a
 * band on `customMessageBg`: a bold `[compaction]`, then `Compacted from 128,412 tokens
 * (ctrl+o to expand)`, with the summary itself behind the expand key. pi-ui recognises that
 * component in its tree walk and replaces its layout: `▸ compaction · 128.4k tokens`, the
 * summary's opening rows in Markdown under it, and a click for the rest.
 *
 * Not through `registerMessageRenderer`: that hook only sees messages an extension sends, and
 * these are built-in roles. This is the same in-place patching that `user-message.ts` does to
 * pi's prompt band, and that `thinking.ts` does to assistant blocks.
 */

import { claimHover, clearHover, releaseHover } from "./hover.ts";
import { summaryLayout, type SummaryApi, type SummaryKind } from "../render/summary.ts";

interface SummaryMessage {
  role?: string;
  summary?: string;
  tokensBefore?: number;
}

interface SummaryLike {
  message?: SummaryMessage;
  expanded?: boolean;
  render?(width: number): string[];
  invalidate?(): void;
  updateDisplay?(): void;
  setExpanded?(expanded: boolean): void;
  handleMouse?(event: MouseEventLike): unknown;
}

interface MouseEventLike {
  type?: string;
  button?: string;
}

interface SummaryState {
  kind: SummaryKind;
  summary: string;
  tokensBefore?: number;
  expanded: boolean;
  hover: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Whether a click has rows to reveal: known after the first render. */
  canToggle: boolean;
  api: SummaryApi;
}

const PATCHED = "__piUiSummary";
const states = new WeakMap<object, SummaryState>();
/** Terminals do not report the pointer leaving: a move lights the block, a short timer clears it. */
const HOVER_MS = 1200;

/** A compaction or branch summary as pi constructs it: the message names the role, the rest is pi's. */
export function isSummaryComponent(component: unknown): component is SummaryLike {
  if (!component || typeof component !== "object") return false;
  const candidate = component as SummaryLike;
  const role = candidate.message?.role;
  return (
    (role === "compactionSummary" || role === "branchSummary") &&
    typeof candidate.message?.summary === "string" &&
    typeof candidate.expanded === "boolean" &&
    typeof candidate.setExpanded === "function" &&
    typeof candidate.updateDisplay === "function"
  );
}

/** Replace a summary component's layout in place; later calls only pick up a new theme. */
export function compactSummaryBlock(component: SummaryLike, api: SummaryApi): void {
  const patched = states.get(component);
  if (patched) {
    patched.api = api;
    return;
  }
  const message = component.message ?? {};
  const state: SummaryState = {
    kind: message.role === "branchSummary" ? "branch" : "compaction",
    summary: message.summary ?? "",
    tokensBefore: typeof message.tokensBefore === "number" ? message.tokensBefore : undefined,
    expanded: component.expanded === true,
    hover: false,
    canToggle: false,
    api,
  };
  states.set(component, state);
  (component as Record<string, unknown>)[PATCHED] = true;

  const clear = () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.hover = false;
    component.invalidate?.();
  };

  // pi's own layout never runs again: it would bring back the band, the `[compaction]` label and
  // the expand hint, and it rebuilds its children on every expand.
  component.updateDisplay = () => {};
  component.setExpanded = (expanded: boolean) => {
    state.expanded = expanded;
    component.expanded = expanded;
  };
  component.render = (width: number) => {
    const layout = summaryLayout(state.api, {
      kind: state.kind,
      summary: state.summary,
      ...(state.tokensBefore === undefined ? {} : { tokensBefore: state.tokensBefore }),
      expanded: state.expanded,
      lit: state.hover,
      width,
    });
    state.canToggle = layout.canToggle;
    return layout.rows;
  };
  component.handleMouse = (event: MouseEventLike) => {
    if (event.type !== "move" && event.type !== "click") return undefined;
    // A summary with nothing more to show is inert: no hover, no click.
    if (!state.canToggle) {
      const changed = clearHover();
      return { handled: true, render: changed };
    }
    claimHover(state, clear);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      releaseHover(state);
      clear();
    }, HOVER_MS);
    if (event.type === "click") {
      if (event.button !== undefined && event.button !== "left") return undefined;
      state.expanded = !state.expanded;
      component.expanded = state.expanded;
      // "render" repaints now: pi's frame loop reads the new rows on this event.
      return { handled: true, render: true };
    }
    const changed = !state.hover;
    state.hover = true;
    if (changed) component.invalidate?.();
    return { handled: true, render: changed };
  };
}
