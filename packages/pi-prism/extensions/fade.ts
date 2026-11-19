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
}

export const DECAY_FRAME_MS = 90;
// Four 90 ms frames: a departing row is gone in 360 ms.
export const FADE_FRAMES = 4;

// Keep each departing row in the layout until its final fade frame.
const decayFrames = new WeakMap<object, DecayFrame>();
const toolFrames = new Map<string, DecayFrame>();

export function fadeOf(component: object): DecayFrame | undefined {
  return decayFrames.get(component);
}

export function startFade(component: object, key: string | undefined, folding: boolean): DecayFrame {
  const frame: DecayFrame = { folding, phase: 0, removed: 0, foldRows: 0 };
  decayFrames.set(component, frame);
  if (key !== undefined) toolFrames.set(key, frame);
  return frame;
}

export function endFade(component: object, key: string | undefined): void {
  decayFrames.delete(component);
  if (key !== undefined) toolFrames.delete(key);
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

/** A block joining a group folds from the bottom, one row per fade, ending with its heading. */
export function paintFold(rows: string[], theme: RenderTheme, component: object): string[] {
  const frame = decayFrames.get(component);
  if (!frame?.folding || !rows.length) return rows;
  const lines = rows.slice();
  const heading = lines.findIndex((line) => visibleWidth(line) > 0);
  if (heading < 0) return rows;
  frame.foldRows = lines.length - heading;
  lines.length = Math.max(heading + 1, lines.length - frame.removed);
  const last = lines.length - 1;
  lines[last] = fadeLine(lines[last]!, frame.phase, theme);
  return lines;
}
