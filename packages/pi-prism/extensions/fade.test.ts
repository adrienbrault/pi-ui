import { describe, expect, test } from "bun:test";
import {
  advanceFade,
  BACKLOG_MIN_MS,
  BACKLOG_TOTAL_MS,
  backlogIntervalMs,
  backlogRows,
  blocksArrived,
  endFade,
  type PaceClock,
  FADE_FRAMES,
  fadeDurationMs,
  fadeOf,
  nextPace,
  paintFold,
  paintLeaving,
  startFade,
  toolFade,
} from "./fade.ts";
import type { RenderTheme } from "../render/kit.ts";
import { maxRowsFor } from "../render/detail.ts";

/** Tick until the step completes; the states seen before each tick. */
function ticks(frame: ReturnType<typeof startFade>): Array<[number, number]> {
  const seen: Array<[number, number]> = [];
  for (let guard = 0; guard < 100; guard++) {
    seen.push([frame.removed, frame.phase]);
    if (advanceFade(frame)) return seen;
  }
  throw new Error("the fade never completed");
}

describe("fade advance", () => {
  test("a step runs its phases, then completes", () => {
    const frame = startFade({}, undefined, false);
    expect(ticks(frame)).toEqual(Array.from({ length: FADE_FRAMES }, (_, phase) => [0, phase]));
  });

  test("a step that drops no row completes on its first tick", () => {
    const frame = startFade({}, undefined, false);
    frame.idle = true;
    expect(ticks(frame)).toEqual([[0, 0]]);
  });

  test("a fold removes one row per fade, ending with its heading", () => {
    const frame = startFade({}, undefined, true);
    frame.foldRows = 3;
    const phases = Array.from({ length: FADE_FRAMES }, (_, phase) => phase);
    expect(ticks(frame)).toEqual([0, 1, 2].flatMap((removed) => phases.map((phase) => [removed, phase])));
  });

  test("a backlog fold skips the fade phases: one row leaves per tick, ending with its heading", () => {
    const frame = startFade({}, undefined, true);
    frame.backlog = true;
    frame.foldRows = 3;
    expect(ticks(frame)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  test("a block with several parts goes idle only when no part has a row to fade", () => {
    const theme = { fg: (_token: string, text: string) => text } as unknown as RenderTheme;
    const frame = startFade({}, undefined, false);
    // Two thinking runs of one message share the frame: the first fades a row, the second has none.
    paintLeaving(["a", "b"], 1, frame, theme, 0);
    paintLeaving(["c"], undefined, frame, theme, 1);
    expect(frame.idle).toBe(false);
    paintLeaving(["a"], undefined, frame, theme, 0);
    expect(frame.idle).toBe(true);
  });

  test("a fold starts at the first visible row, so a leading spacer stays, and a kept heading never fades", () => {
    const theme = { fg: (token: string, text: string) => `[${token}]${text}` } as unknown as RenderTheme;
    const component = {};
    const frame = startFade(component, undefined, true, 90, true);
    // An assistant component renders a blank spacer above its thinking heading.
    const rows = ["", "● Thought", "body 1", "body 2"];
    frame.phase = 1;
    expect(paintFold(rows, theme, component)).toEqual(["", "● Thought", "body 1", "[dim]body 2"]);
    expect(frame.foldRows).toBe(2);
    frame.removed = 1;
    expect(paintFold(rows, theme, component)).toEqual(["", "● Thought", "[dim]body 1"]);
    frame.removed = 2;
    expect(paintFold(rows, theme, component)).toEqual(["", "● Thought"]);
  });

  test("a tool frame is found by its call id until it ends", () => {
    const component = {};
    const frame = startFade(component, "call", false);
    expect(toolFade("call")).toBe(frame);
    expect(fadeOf(component)).toBe(frame);
    endFade(component);
    expect(toolFade("call")).toBeUndefined();
    expect(fadeOf(component)).toBeUndefined();
    startFade(component, "fold", true);
    expect(toolFade("fold")).toBeUndefined();
  });
});

describe("fade pace", () => {
  test("a row fades over a quarter of the recent gap between blocks, within 80 to 480 ms", () => {
    expect(fadeDurationMs()).toBe(360);
    expect(fadeDurationMs(8000)).toBe(480);
    expect(fadeDurationMs(600)).toBe(150);
    expect(fadeDurationMs(200)).toBe(80);
  });

  test("the pace is a moving average seeded by its first gap, and an idle gap is ignored", () => {
    expect(nextPace(undefined, 400)).toBe(400);
    expect(nextPace(400, 1400)).toBeCloseTo(700);
    expect(nextPace(400, 60_001)).toBe(400);
    expect(nextPace(undefined, 60_001)).toBeUndefined();
  });

  test("blocks arriving within one frame of each other are one arrival", () => {
    const clock: PaceClock = {};
    blocksArrived(clock, 1000);
    expect(clock).toEqual({ lastAt: 1000 });
    blocksArrived(clock, 1800);
    blocksArrived(clock, 1801);
    expect(clock).toEqual({ pace: 800, lastAt: 1800 });
    blocksArrived(clock, 2600);
    expect(clock).toEqual({ pace: 800, lastAt: 2600 });
  });
});

describe("backlog pace", () => {
  test("a backlog spreads its rows over the total, no faster than the floor and no slower than one fade", () => {
    expect(BACKLOG_TOTAL_MS).toBe(1500);
    expect(BACKLOG_MIN_MS).toBe(25);
    // A big backlog runs at the floor.
    expect(backlogIntervalMs(120)).toBe(BACKLOG_MIN_MS);
    expect(backlogIntervalMs(60, 10_000)).toBe(25);
    // A small one takes no longer per row than a fade would.
    expect(backlogIntervalMs(1)).toBe(fadeDurationMs());
    expect(backlogIntervalMs(2, 10_000)).toBe(480);
    expect(backlogIntervalMs(6, 10_000)).toBe(250);
    expect(backlogIntervalMs(0)).toBe(fadeDurationMs());
  });

  test("rows still to leave count each level a block loses, and its rows at the last standalone level when it folds", () => {
    // Two levels down, one row each.
    expect(backlogRows(1, 3)).toBe(2);
    // From the live level to the fold: four steps, then the heading and four body rows.
    expect(backlogRows(0, 5)).toBe(4 + maxRowsFor(4));
    // Already at the last standalone level; joining a group that lists it keeps the heading.
    expect(backlogRows(4, 5)).toBe(maxRowsFor(4));
    expect(backlogRows(4, 5, true)).toBe(maxRowsFor(4) - 1);
    expect(backlogRows(3, 3)).toBe(0);
  });
});
