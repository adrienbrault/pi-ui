import { compositeTuiLine, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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

/** A block's scroll bar sits in the second cell of each row: column 0 keeps its glyph or indent. */
export const BAR_COLUMN = 1;

/**
 * Composite one styled bar cell into column 1 of `row`. Every block kind has a
 * space there (after a heading's marker, or inside an indent); a row whose
 * column 1 holds a glyph keeps it and goes unpainted.
 */
export function paintBarCell(row: string, cell: string, width: number): string {
  if (width <= BAR_COLUMN) return row;
  const [first, second] = [...stripTerminalSequences(row)];
  if ((first !== undefined && visibleWidth(first) > BAR_COLUMN) || (second !== undefined && second !== " ")) return row;
  return compositeTuiLine(row, cell, BAR_COLUMN, 1, width);
}

/** Paint the bar column of `rows[from + i]` with `cells[i]`. */
export function paintBar(
  rows: string[],
  from: number,
  cells: readonly BarCell[],
  paint: (cell: BarCell) => string,
  width: number,
): void {
  cells.forEach((cell, index) => {
    const row = rows[from + index];
    if (row !== undefined) rows[from + index] = paintBarCell(row, paint(cell), width);
  });
}

/**
 * The scroll bar drawn in column 1 of an open block's visible rows: track on
 * every visible row and one thumb cell ("fill") marking the reader's position
 * in the block. The thumb sits on the first visible row at the block's top, on
 * the last at its end, and moves down as the reader scrolls down. A block that
 * fits on screen has nothing to scroll: its thumb stays on its first row.
 */
export function scrollBarRows(spans: Span[], top: number, height: number): Map<number, BarCell> {
  const cells = new Map<number, BarCell>();
  for (const span of spans) {
    const first = Math.max(span.start, top);
    const last = Math.min(span.end, top + height);
    const visible = last - first;
    if (visible <= 0) continue;
    const range = span.end - span.start - visible;
    const thumb = range > 0 ? first + Math.round(((visible - 1) * (first - span.start)) / range) : first;
    for (let row = first; row < last; row++) cells.set(row, row === thumb ? "fill" : "track");
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
      if (frame[row] !== undefined) frame[row] = paintBarCell(frame[row]!, paint.bar(cell), width);
    }
    return frame;
  };
}
