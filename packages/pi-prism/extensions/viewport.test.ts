import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  decorateViewport,
  expandedRegions,
  expandedSpans,
  offscreenHistory,
  paintBarCell,
  scrollBarRows,
} from "./viewport.ts";

test("fully offscreen blocks age while a single visible row protects the whole block", () => {
  const old = {},
    partial = {},
    newest = {};
  const chat = {
    mouseLayout: {
      children: [
        { component: old, height: 3 },
        { component: partial, height: 7 },
        { component: newest, height: 4 },
      ],
    },
  };
  const document = { mouseLayout: { children: [{ component: chat, height: 14 }] } };
  const view = { children: [document], viewportHeight: 5, scrollTop: 9 };
  const root = { mode: "fullscreen", getPrimaryScrollView: () => view };
  expect([...offscreenHistory(root)]).toEqual([old]);
  view.scrollTop = 0;
  expect([...offscreenHistory(root)]).toEqual([newest]);
  view.scrollTop = 10;
  view.viewportHeight = 4;
  expect([...offscreenHistory(root)]).toEqual([old, partial]);
  view.viewportHeight = 14;
  view.scrollTop = 0;
  expect(offscreenHistory(root).size).toBe(0);
  const regular = {
    mode: "regular",
    terminal: { rows: 8 },
    mouseLayout: {
      children: [
        { component: document, height: 14 },
        { component: {}, height: 3 },
      ],
    },
  };
  expect([...offscreenHistory(regular)]).toEqual([old]);
});

// A 20-row open block (rows 2..21 of the document) after 2 rows of history.
function documentWith(blockRows: number) {
  const block = {};
  expandedRegions.set(block, () => true);
  // The region's last row is its footer and does not count, as in insideExpanded.
  return {
    mouseLayout: {
      children: [
        { component: {}, height: 2 },
        { component: block, height: blockRows + 1 },
      ],
    },
  };
}

describe("scroll bar of an open block", () => {
  test("finds the open block's rows and nothing else", () => {
    expect(expandedSpans(documentWith(20), 0, 30)).toEqual([{ start: 2, end: 22 }]);
    expect(expandedSpans(documentWith(20), 23, 5)).toEqual([]);
  });

  test("the fill rises from the bottom of the visible slice as the reader scrolls up", () => {
    const span = { start: 2, end: 22 };
    const bar = (top: number) => scrollBarRows([span], top, 10);
    const filled = (top: number) => [...bar(top).values()].filter((kind) => kind === "fill").length;
    // At the block's end nothing is filled; at its top the whole visible track is.
    expect(filled(12)).toBe(0);
    expect(filled(2)).toBe(10);
    expect(filled(7)).toBe(5);
    // Filled rows sit at the bottom of the visible slice, so the fill's edge is always on screen.
    expect([...bar(7)].filter(([, kind]) => kind === "fill").map(([row]) => row)).toEqual([12, 13, 14, 15, 16]);
    // Only visible rows of the block are painted.
    expect([...bar(0).keys()]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a block that fits on screen shows a full bar", () => {
    const bar = scrollBarRows([{ start: 2, end: 6 }], 0, 10);
    expect([...bar.values()]).toEqual(["fill", "fill", "fill", "fill"]);
  });

  test("the document render paints column 1 of the visible open rows and leaves column 0 alone", () => {
    const doc = Object.assign(documentWith(20), {
      render: (width: number) => Array.from({ length: 23 }, (_, row) => `    row ${row}`.padEnd(width)),
    });
    const view = { children: [doc], viewportHeight: 10, scrollTop: 7, isFollowingEnd: false };
    decorateViewport(
      { mode: "fullscreen", getPrimaryScrollView: () => view },
      { bar: (kind) => (kind === "fill" ? "#" : ":") },
    );
    const lines = doc.render(20).map(stripTerminalSequences);
    expect(lines.slice(7, 17).map((line) => line[1])).toEqual([":", ":", ":", ":", ":", "#", "#", "#", "#", "#"]);
    expect(lines.slice(7, 17).every((line) => line[0] === " " && line.slice(2, 4) === "  ")).toBe(true);
    expect(lines[6]?.[1]).toBe(" ");
    expect(lines[17]?.[1]).toBe(" ");
  });

  test("a bar cell takes column 1 only where the row has a space or nothing there", () => {
    expect(stripTerminalSequences(paintBarCell("✻ think", "#", 10))).toBe("✻#think   ");
    expect(stripTerminalSequences(paintBarCell("  ▸ Ran 2", "#", 10))).toBe(" #▸ Ran 2 ");
    expect(stripTerminalSequences(paintBarCell("", "#", 4))).toBe(" #  ");
    expect(paintBarCell("ab", "#", 4)).toBe("ab");
    expect(paintBarCell("界x", "#", 4)).toBe("界x");
    expect(paintBarCell(" x", "#", 1)).toBe(" x");
  });
});
