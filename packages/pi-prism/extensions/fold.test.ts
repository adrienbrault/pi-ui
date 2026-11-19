import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { type FoldUnit, planFolds, setGroupOpen, thinkingPlan, toolPlan } from "./fold.ts";

import { DEFAULT_TAIL_LINES, setTailLines } from "../render/detail.ts";
// Exercise the compact seven-row configuration used by these fixtures.
beforeEach(() => setTailLines(7));
afterEach(() => setTailLines(DEFAULT_TAIL_LINES));

function unit(kind: "thinking" | "tool", key: string, distance: number): FoldUnit {
  const component = { key };
  return {
    kind,
    key,
    component,
    count: 1,
    cls: kind === "thinking" ? "thinking" : "shell",
    distance,
    invalidate: () => {},
  };
}

describe("live fold plan", () => {
  test("thoughts and commands that recede together share one summary", () => {
    const units = [
      unit("thinking", "t0", 18),
      unit("thinking", "t1", 17),
      unit("thinking", "t2", 16),
      ...Array.from({ length: 16 }, (_, index) => unit("tool", `c${index}`, 15 - index)),
    ];
    planFolds(units);
    const anchor = thinkingPlan(units[0]!.component);
    expect(anchor?.mode).toBe("anchor");
    expect(anchor?.group?.segments).toEqual([
      { cls: "thinking", count: 3 },
      { cls: "shell", count: 12 },
    ]);
    expect(toolPlan("c0")?.mode).toBe("hidden");
    expect(toolPlan("c12")?.mode).toBe("normal");
  });

  test("a summary totals thinking time and shell runtime, and a later timing refreshes it", () => {
    const units = [
      { ...unit("thinking", "t0", 14), count: 2, activeMs: 200_000 },
      { ...unit("thinking", "t1", 12), activeMs: 20_000 },
      ...Array.from({ length: 6 }, (_, index) => ({ ...unit("tool", `r${index}`, 11 - index), activeMs: 1000 })),
    ];
    planFolds(units);
    expect(thinkingPlan(units[0]!.component)?.group?.segments).toEqual([
      { cls: "thinking", count: 3, durationMs: 220_000 },
      { cls: "shell", count: 6, durationMs: 6000 },
    ]);
    // One command whose runtime is unknown: the shell total would understate, so it is dropped.
    planFolds(units.map((item) => (item.key === "r0" ? { ...item, activeMs: undefined } : item)));
    expect(thinkingPlan(units[0]!.component)?.group?.segments).toEqual([
      { cls: "thinking", count: 3, durationMs: 220_000 },
      { cls: "shell", count: 6 },
    ]);
  });

  test("a boundary keeps its own row and starts a new group", () => {
    const units = [
      unit("tool", "a0", 9),
      unit("tool", "a1", 8),
      { ...unit("tool", "fail", 7), failed: true, boundary: true },
      unit("tool", "b0", 3),
    ];
    planFolds(units);
    expect(toolPlan("a0")?.mode).toBe("anchor");
    expect(toolPlan("a1")?.mode).toBe("hidden");
    expect(toolPlan("fail")?.mode).toBe("normal");
    expect(toolPlan("b0")?.mode).toBe("normal");
  });

  test("elapsed time includes model latency and uses the latest finish of overlapping tools", () => {
    const units = [
      { ...unit("thinking", "timed", 12), startedAt: 1000, endedAt: 7000 },
      { ...unit("tool", "slow", 11), startedAt: 7100, endedAt: 9500 },
      { ...unit("tool", "fast", 10), startedAt: 7150, endedAt: 7300 },
    ];
    planFolds(units);
    expect(toolPlan("fast")?.group?.durationMs).toBe(8500);
    planFolds([{ ...units[0]!, endedAt: undefined }, ...units.slice(1)]);
    expect(toolPlan("fast")?.group?.durationMs).toBeUndefined();
    planFolds([units[0]!, { ...units[1]!, startsRun: true }, units[2]!]);
    expect(toolPlan("fast")?.group?.durationMs).toBe(2400);
  });

  test("an unchanged transcript invalidates no tools or thoughts", () => {
    const units = [unit("thinking", "thought", 10), unit("tool", "old", 9), unit("tool", "recent", 0)];
    planFolds(units);
    expect(planFolds(units).size).toBe(0);
    units[1]!.endedAt = 42;
    expect(planFolds(units)).toEqual(new Set([units[0]!.component, units[1]!.component]));
  });

  test("an open group stays open when a completed tool becomes its new anchor", () => {
    const before = unit("tool", "was-running", 10);
    const member = unit("tool", "inspected", 9);
    planFolds([{ ...before, boundary: true }, member]);
    setGroupOpen(toolPlan(member.key)!.group!, true);
    planFolds([before, member]);
    const group = toolPlan(before.key)!.group!;
    expect(group.open).toBe(true);
    setGroupOpen(group, false);
    planFolds([member]);
    expect(toolPlan(member.key)?.group?.open).toBe(false);
  });

  test("opening a group survives the next plan", () => {
    const units = [unit("tool", "a0", 9), unit("tool", "a1", 8)];
    planFolds(units);
    const group = toolPlan("a0")?.group;
    expect(group?.open).toBe(false);
    setGroupOpen(group!, true);
    planFolds([unit("tool", "a0", 9), unit("tool", "a1", 8)]);
    expect(toolPlan("a0")?.group?.open).toBe(true);
  });
});
