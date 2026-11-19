import { beforeEach, describe, expect, test } from "bun:test";
import { bodyLinesFor } from "../render/detail.ts";
import { blockDistances, type PlanBlock } from "../render/layout.ts";
import type { GroupClass } from "../render/tools.ts";
import { type FoldUnit, planFolds, resetFolds, setGroupOpen, thinkingPlan, toolPlan } from "./fold.ts";

beforeEach(resetFolds);

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

/** Tool units in visual order, distances from the shared rule. */
function tools(classes: GroupClass[], failed: number[] = []): FoldUnit[] {
  const distances = blockDistances(classes.map((): PlanBlock => ({ kind: "tool" })));
  return classes.map((cls, index) => ({
    ...unit("tool", `k${index}`, distances[index]!.distance),
    cls,
    failed: failed.includes(index),
  }));
}

describe("live fold plan", () => {
  test("the default keeps five recent blocks and reduces an eight-row preview to four before folding", () => {
    const units = tools(Array<GroupClass>(12).fill("read"));
    planFolds(units);
    expect(toolPlan("k0")?.group?.members).toHaveLength(7);
    expect(units.slice(7).map((item) => bodyLinesFor(toolPlan(item.key)!.level))).toEqual([4, 5, 6, 7, 8]);
  });

  test("prose after a tool does not age it into a group", () => {
    const blocks: PlanBlock[] = [{ kind: "tool" }, ...Array.from({ length: 5 }, (): PlanBlock => ({ kind: "prose" }))];
    planFolds([unit("tool", "lone", blockDistances(blocks)[0]!.distance)]);
    expect(toolPlan("lone")?.mode).toBe("normal");
  });

  test("folded command totals include failures and count them", () => {
    const units = tools(
      Array.from({ length: 29 }, (): GroupClass => "shell"),
      [0, 3, 12, 23],
    );
    planFolds(units);
    expect(toolPlan("k0")?.group?.members).toHaveLength(24);
    expect(toolPlan("k0")?.group?.segments).toEqual([{ cls: "shell", count: 24, failed: 4 }]);
  });

  test("a recent failure keeps its own row until old enough to fold", () => {
    planFolds(tools(["read", "edit", "read", "read"], [1]));
    expect(toolPlan("k1")).toMatchObject({ mode: "normal", level: 2 });
  });

  test("groups merge counts by class in encounter order", () => {
    const classes: GroupClass[] = [...Array<GroupClass>(9).fill("read"), "edit", ...Array<GroupClass>(10).fill("read")];
    planFolds(tools(classes));
    expect(toolPlan("k0")?.group?.segments).toEqual([
      { cls: "read", count: 14 },
      { cls: "edit", count: 1 },
    ]);
  });

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
      { cls: "shell", count: 11 },
    ]);
    expect(toolPlan("c0")?.mode).toBe("hidden");
    expect(toolPlan("c10")?.mode).toBe("hidden");
    expect(toolPlan("c11")?.mode).toBe("normal");
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
