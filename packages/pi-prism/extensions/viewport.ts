import { compositeTuiLine } from "@earendil-works/pi-tui";
import type { RenderTheme } from "../render/kit.ts";
import type { BarCell } from "../render/tool-row.ts";

export type { BarCell };

/** pi's last measured child heights include wrapping, spacers, and explicit expansion. */
interface MeasuredContainer {
  child?: object;
  mouseLayout?: { children: { component: object; height: number }[] };
}

export interface TranscriptTui extends MeasuredContainer {
  mode?: string;
  terminal?: { rows: number };
  getPrimaryScrollView?: () => {
    children?: object[];
    viewportHeight?: number;
    scrollTop?: number;
    isFollowingEnd?: boolean;
  };
}

/** Locate animation candidates against the actual scrolled viewport. */
export function offscreenHistory(root: TranscriptTui): Set<object> {
  const history = new Set<object>();
  const scroll = root.mode === "fullscreen" ? root.getPrimaryScrollView?.() : undefined;
  const document = root.mode === "fullscreen" ? scroll?.children?.[0] : root;
  const height = scroll?.viewportHeight ?? root.terminal?.rows ?? 0;
  const children = (document as MeasuredContainer | undefined)?.mouseLayout?.children;
  if (!children || height <= 0) return history;
  const total = children.reduce((sum, child) => sum + child.height, 0);
  const top =
    scroll && !scroll.isFollowingEnd && scroll.scrollTop !== undefined ? scroll.scrollTop : Math.max(0, total - height);
  function visit(container: MeasuredContainer, start: number): void {
    for (const { component, height: rows } of container.mouseLayout?.children ?? []) {
      const end = start + rows;
      if (end <= top || start >= top + height) history.add(component);
      if (start < top || end > top + height) visit(component, start);
      start = end;
    }
  }
  visit(document as MeasuredContainer, 0);
  return history;
}

/** Mouse regions of open blocks: a click inside one collapses it, and its rows carry the scroll bar. */
export const expandedRegions = new WeakMap<object, (row: number) => boolean>();
const pinnedDocuments = new WeakSet<object>();

export function insideExpanded(container: MeasuredContainer, row: number, height = 0): boolean {
  if (row < 0) return false;
  const expanded = expandedRegions.get(container);
  if (expanded) return row < height - 1 && expanded(row);
  // Pi wraps result components in a MouseRegion that forwards local coordinates unchanged.
  if (container.child) return insideExpanded(container.child, row, height);
  for (const child of container.mouseLayout?.children ?? []) {
    if (row < child.height) return insideExpanded(child.component, row, child.height);
    row -= child.height;
  }
  return false;
}

/** Document rows `[start, end)` of an open block. */
export interface Span {
  start: number;
  end: number;
}

/** Open blocks that reach into the viewport `[top, top + height)`, in document rows. */
export function expandedSpans(container: MeasuredContainer, top: number, height: number): Span[] {
  const spans: Span[] = [];
  const visit = (node: MeasuredContainer, start: number, rows: number): void => {
    const expanded = expandedRegions.get(node);
    if (expanded) {
      // Same convention as insideExpanded: a region's last row is not part of the open body.
      let open: number | undefined;
      for (let row = 0; row <= rows - 1; row++) {
        const inside = row < rows - 1 && expanded(row);
        if (inside && open === undefined) open = row;
        if (!inside && open !== undefined) {
          spans.push({ start: start + open, end: start + row });
          open = undefined;
        }
      }
      return;
    }
    if (node.child) return visit(node.child, start, rows);
    for (const child of node.mouseLayout?.children ?? []) {
      if (start < top + height && start + child.height > top) visit(child.component, start, child.height);
      start += child.height;
    }
  };
  visit(container, 0, Number.POSITIVE_INFINITY);
  return spans.filter((span) => span.start < top + height && span.end > top);
}

/** One cell of a scroll bar in pi's own scrollbar colours. */
export function styleBarCell(theme: RenderTheme, cell: BarCell): string {
  return theme.style(" ", { bg: theme.colors?.[cell === "fill" ? "scrollbarThumb" : "scrollbarTrack"] });
}

/** Paint column 0 of `rows[from + i]` with `cells[i]`. */
export function paintBar(
  rows: string[],
  from: number,
  cells: readonly BarCell[],
  paint: (cell: BarCell) => string,
  width: number,
): void {
  cells.forEach((cell, index) => {
    const row = rows[from + index];
    if (row !== undefined) rows[from + index] = compositeTuiLine(row, paint(cell), 0, 1, width);
  });
}

/**
 * The scroll bar drawn in column 0 of an open block's visible rows. The fill
 * rises from the bottom of the visible slice: empty at the block's end, full
 * once its first row is on screen. Its edge is always within the viewport.
 */
export function scrollBarRows(spans: Span[], top: number, height: number): Map<number, BarCell> {
  const cells = new Map<number, BarCell>();
  for (const span of spans) {
    const first = Math.max(span.start, top);
    const last = Math.min(span.end, top + height);
    const visible = last - first;
    if (visible <= 0) continue;
    const range = span.end - span.start - height;
    const progress = range > 0 ? Math.min(1, Math.max(0, 1 - (top - span.start) / range)) : 1;
    const filled = Math.round(progress * visible);
    for (let row = first; row < last; row++) cells.set(row, row >= last - filled ? "fill" : "track");
  }
  return cells;
}

export interface ViewportPaint {
  /** One styled cell of the open block's scroll bar. */
  bar: (cell: BarCell) => string;
}

/** Fullscreen only: the scrolled viewport is known there, and not in inline mode. */
export function decorateViewport(root: TranscriptTui, paint: ViewportPaint): void {
  const scroll = root.mode === "fullscreen" ? root.getPrimaryScrollView?.() : undefined;
  const doc = scroll?.children?.[0] as (MeasuredContainer & { render(width: number): string[] }) | undefined;
  if (!scroll || !doc || typeof doc.render !== "function" || pinnedDocuments.has(doc)) return;
  pinnedDocuments.add(doc);
  const render = doc.render.bind(doc);
  doc.render = (width) => {
    const lines = render(width);
    const height = scroll.viewportHeight ?? 0;
    if (height <= 0 || width <= 0) return lines;
    const top =
      !scroll.isFollowingEnd && scroll.scrollTop !== undefined ? scroll.scrollTop : Math.max(0, lines.length - height);
    const bar = scrollBarRows(expandedSpans(doc, top, height), top, height);
    if (bar.size === 0) return lines;
    const frame = lines.slice();
    for (const [row, cell] of bar) {
      if (frame[row] !== undefined) frame[row] = compositeTuiLine(frame[row]!, paint.bar(cell), 0, 1, width);
    }
    return frame;
  };
}
