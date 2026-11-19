import { compositeTuiLine, visibleWidth } from "@earendil-works/pi-tui";

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

/** Mouse regions that can collapse the block beneath a pinned chip. */
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

export function pinCollapse(root: TranscriptTui, chip: (width: number) => string): void {
  const scroll = root.mode === "fullscreen" ? root.getPrimaryScrollView?.() : undefined;
  const doc = scroll?.children?.[0] as (MeasuredContainer & { render(width: number): string[] }) | undefined;
  if (!scroll || !doc || typeof doc.render !== "function" || pinnedDocuments.has(doc)) return;
  pinnedDocuments.add(doc);
  const render = doc.render.bind(doc);
  doc.render = (width) => {
    const lines = render(width);
    const bottom = (scroll.scrollTop ?? 0) + (scroll.viewportHeight ?? 0) - 1;
    if (scroll.isFollowingEnd || bottom < 0 || bottom >= lines.length - 1 || !insideExpanded(doc, bottom)) return lines;
    const frame = lines.slice();
    const overlay = chip(width);
    frame[bottom] = compositeTuiLine(lines[bottom]!, overlay, 0, visibleWidth(overlay), width);
    return frame;
  };
}
