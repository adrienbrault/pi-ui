import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  barTokens,
  decorateViewport,
  expandedRegions,
  expandedSpans,
  hoveredRegions,
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
  return {
    mouseLayout: {
      children: [
        { component: {}, height: 2 },
        { component: block, height: blockRows },
      ],
    },
  };
}

describe("scroll bar of an open block", () => {
  test("finds the open block's rows and nothing else", () => {
    expect(expandedSpans(documentWith(20), 0, 30)).toEqual([{ start: 2, end: 22 }]);
    expect(expandedSpans(documentWith(20), 23, 5)).toEqual([]);
  });

  test("one thumb cell marks the reader's position: top, middle, end", () => {
    const span = { start: 2, end: 22 };
    const bar = (top: number) => scrollBarRows([span], top, 10);
    const thumbs = (top: number) => [...bar(top)].filter(([, kind]) => kind === "fill").map(([row]) => row);
    // At the block's top the thumb is on the first visible row, at its end on the last.
    expect(thumbs(2)).toEqual([2]);
    expect(thumbs(12)).toEqual([21]);
    // Halfway through the scroll range, halfway down the visible slice.
    expect(thumbs(7)).toEqual([12]);
    expect(thumbs(3)).toEqual([4]);
    // Every other visible row of the block is track, and only visible rows are painted.
    for (const top of [0, 2, 5, 7, 12, 15]) expect(thumbs(top)).toHaveLength(1);
    expect([...bar(0).keys()]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(thumbs(0)).toEqual([2]);
    // Only the block's tail on screen: the reader is at its end.
    expect(thumbs(15)).toEqual([21]);
  });

  test("a block shown whole fills its bar: there is nothing to scroll", () => {
    const bar = scrollBarRows([{ start: 2, end: 6 }], 0, 10);
    expect([...bar.values()]).toEqual(["fill", "fill", "fill", "fill"]);
  });

  test("each open block on screen has its own single thumb", () => {
    const bar = scrollBarRows(
      [
        { start: 0, end: 4 },
        { start: 6, end: 30 },
      ],
      2,
      10,
    );
    // The first block shows only its end, so its thumb is on its last row; the second shows its top.
    expect([...bar].filter(([, kind]) => kind === "fill").map(([row]) => row)).toEqual([3, 6]);
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
    expect(lines.slice(7, 17).map((line) => line[1])).toEqual([":", ":", ":", ":", ":", "#", ":", ":", ":", ":"]);
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

describe("hovered open block", () => {
  test("its span is marked, and the document paints its bar in the hovered colours", () => {
    const doc = Object.assign(documentWith(4), {
      render: (width: number) => Array.from({ length: 6 }, (_, row) => `    row ${row}`.padEnd(width)),
    });
    const block = doc.mouseLayout.children[1]!.component;
    let hovered = false;
    hoveredRegions.set(block, () => hovered);
    expect(expandedSpans(doc, 0, 10)).toEqual([{ start: 2, end: 6 }]);
    hovered = true;
    expect(expandedSpans(doc, 0, 10)).toEqual([{ start: 2, end: 6, hovered: true }]);
    const view = { children: [doc], viewportHeight: 10, scrollTop: 0, isFollowingEnd: false };
    decorateViewport(
      { mode: "fullscreen", getPrimaryScrollView: () => view },
      { bar: (kind, over) => (over ? (kind === "fill" ? "H" : "h") : kind === "fill" ? "#" : ":") },
    );
    expect(doc.render(20).map((line) => stripTerminalSequences(line)[1])).toEqual([" ", " ", "H", "H", "H", "H"]);
    hovered = false;
    expect(doc.render(20).map((line) => stripTerminalSequences(line)[1])).toEqual([" ", " ", "#", "#", "#", "#"]);
  });

  test("a hovered bar paints accent on selectedBg; at rest pi's scrollbar pair", () => {
    const colors = { scrollbarThumb: "#97a0a5", scrollbarTrack: "#484e52" };
    expect(barTokens(colors)).toEqual({ fill: "scrollbarThumb", track: "scrollbarTrack" });
    expect(barTokens(colors, true)).toEqual({ fill: "accent", track: "selectedBg" });
  });

  test("when pi's system theme gives both scrollbar tokens one grey, the thumb takes the accent", () => {
    // Before the terminal reports its colours: both tokens resolve to the same faint grey.
    const grey = { kind: "rgb", r: 114, g: 114, b: 115 };
    expect(barTokens({ scrollbarThumb: { ...grey }, scrollbarTrack: { ...grey } })).toEqual({
      fill: "accent",
      track: "scrollbarTrack",
    });
  });
});
