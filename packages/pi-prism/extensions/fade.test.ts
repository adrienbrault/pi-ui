import { describe, expect, test } from "bun:test";
import {
  advanceFade,
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
