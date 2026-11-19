/**
 * The fade: how a visible block steps down one level, or folds into a group.
 *
 * A step paints the departing row through the fade phases, then the next plan
 * drops it. A fold removes rows from the bottom, one fade per row, ending with
 * the heading. Frames are keyed by the component in the tree; tool frames are
 * also indexed by call id, because the tool body renderer knows only the id.
 */

import { mixColors, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RenderTheme } from "../render/kit.ts";

export interface DecayFrame {
  folding: boolean;
  phase: number;
  removed: number;
  foldRows: number;
  /** The step drops no row: nothing to fade, so the next tick commits it. */
  idle?: boolean;
  /** Time between ticks, read from the session's pace when each row starts. */
  frameMs: number;
  /** A fold into a forming group: the heading stays, as the member row. */
  keepHeading?: boolean;
  /** New blocks arrived mid-collapse: finish the row that is fading, then the rest at once. */
  hurry?: boolean;
  /** Blocks in the transcript when a collapse started: more later means new blocks arrived. */
  blocks?: number;
  /** A group collapse: the members whose rows were listed when it started. The others are gone. */
  shown?: Set<object>;
  /** The tool call id that also indexes this frame. */
  key?: string;
}

export const DECAY_FRAME_MS = 90;
// Four frames per departing row: 360 ms until the session's pace is known.
export const FADE_FRAMES = 4;
/** A departing row fades over this share of the recent gap between new blocks. */
export const FADE_SHARE_OF_PACE = 1 / 4;
export const MIN_FADE_MS = 80;
export const MAX_FADE_MS = 480;
/** Weight of the newest gap in the pace's moving average. */
export const PACE_ALPHA = 0.3;
/** A longer gap is a pause, not a pace: it does not slow the next run's fades. */
export const IDLE_GAP_MS = 60_000;

/** How long one row takes to fade, given the average gap between new blocks. */
export function fadeDurationMs(pace?: number): number {
  if (pace === undefined) return FADE_FRAMES * DECAY_FRAME_MS;
  return Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, pace * FADE_SHARE_OF_PACE));
}

/** Fold one gap between new blocks into the pace; the first gap seeds it. */
export function nextPace(pace: number | undefined, gapMs: number): number | undefined {
  if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > IDLE_GAP_MS) return pace;
  return pace === undefined ? gapMs : pace + PACE_ALPHA * (gapMs - pace);
}

// Keep each departing row in the layout until its final fade frame.
const decayFrames = new WeakMap<object, DecayFrame>();
const toolFrames = new Map<string, DecayFrame>();

export function fadeOf(component: object): DecayFrame | undefined {
  return decayFrames.get(component);
}

export function startFade(
  component: object,
  key: string | undefined,
  folding: boolean,
  frameMs = DECAY_FRAME_MS,
  keepHeading = false,
): DecayFrame {
  const frame: DecayFrame = { folding, phase: 0, removed: 0, foldRows: 0, frameMs, keepHeading };
  if (key !== undefined) frame.key = key;
  decayFrames.set(component, frame);
  if (key !== undefined) toolFrames.set(key, frame);
  return frame;
}

/** End a component's fade, and its call-id entry unless a rebuilt component with that id owns a newer one. */
export function endFade(component: object): void {
  const frame = decayFrames.get(component);
  decayFrames.delete(component);
  if (frame?.key !== undefined && toolFrames.get(frame.key) === frame) toolFrames.delete(frame.key);
}

/** Hand a collapse to the group that replaced the collapsing one. */
export function moveFade(from: object, to: object): DecayFrame | undefined {
  const frame = decayFrames.get(from);
  if (!frame) return undefined;
  decayFrames.delete(from);
  decayFrames.set(to, frame);
  return frame;
}

export function resetFades(): void {
  toolFrames.clear();
}

/** A tool's step-down fade, if one is running: its body paints the leaving row. */
export function toolFade(key: string): DecayFrame | undefined {
  const frame = toolFrames.get(key);
  return frame && !frame.folding ? frame : undefined;
}

/**
 * One tick: the next phase, then for a fold the next row, then done. Returns
 * true when the step is complete and the plan may commit it.
 */
export function advanceFade(frame: DecayFrame): boolean {
  if (frame.phase < FADE_FRAMES - 1 && !frame.idle) {
    frame.phase++;
    return false;
  }
  if (frame.folding && frame.removed + 1 < frame.foldRows) {
    frame.removed++;
    frame.phase = 0;
    return false;
  }
  return true;
}

export function fadeLine(line: string, phase: number, theme: RenderTheme): string {
  if (phase === 0) return line;
  const remaining = stripTerminalSequences(line);
  const palette = theme as unknown as Pick<Theme, "colors" | "style">;
  const foreground = palette.colors?.toolOutput;
  const background = palette.colors?.toolPendingBg;
  if (!foreground || !background) return theme.fg("dim", remaining);
  const fg = mixColors(foreground, background, phase / (FADE_FRAMES - 1), "srgb");
  return palette.style(remaining, { fg });
}

/**
 * Paint the row a step drops at the frame's phase. An undefined row means the
 * step drops nothing, and the frame goes idle.
 */
export function paintLeaving(rows: string[], row: number | undefined, frame: DecayFrame, theme: RenderTheme): string[] {
  if (row === undefined || row < 0 || row >= rows.length) {
    frame.idle = true;
    return rows;
  }
  const lines = rows.slice();
  lines[row] = fadeLine(lines[row]!, frame.phase, theme);
  return lines;
}

/**
 * A block joining a group folds from the bottom, one row per fade, ending with
 * its heading. Joining a forming group, it stops above the heading: the heading
 * becomes its member row.
 */
export function paintFold(rows: string[], theme: RenderTheme, component: object): string[] {
  const frame = decayFrames.get(component);
  if (!frame?.folding || !rows.length) return rows;
  const lines = rows.slice();
  const heading = lines.findIndex((line) => visibleWidth(line) > 0);
  if (heading < 0) return rows;
  frame.foldRows = lines.length - heading - (frame.keepHeading ? 1 : 0);
  if (frame.foldRows <= 0) {
    frame.idle = true;
    return rows;
  }
  lines.length = Math.max(heading + 1, lines.length - frame.removed);
  const last = lines.length - 1;
  if (!(frame.keepHeading && last === heading)) lines[last] = fadeLine(lines[last]!, frame.phase, theme);
  return lines;
}
