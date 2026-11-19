import { expect, test } from "bun:test";
import { offscreenHistory } from "./viewport.ts";

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
