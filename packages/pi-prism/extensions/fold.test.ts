import { describe, expect, test } from "bun:test";
import { type FoldUnit, planFolds, setGroupOpen, thinkingPlan, toolPlan } from "./fold.ts";

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
      { cls: "shell", count: 8 },
    ]);
    expect(toolPlan("c0")?.mode).toBe("hidden");
    expect(toolPlan("c8")?.mode).toBe("normal");
  });

  test("a boundary keeps its own row and starts a new group", () => {
    const units = [
      unit("tool", "a0", 9),
      unit("tool", "a1", 8),
      { ...unit("tool", "fail", 7), failed: true, boundary: true },
      unit("tool", "b0", 6),
    ];
    planFolds(units);
    expect(toolPlan("a0")?.mode).toBe("anchor");
    expect(toolPlan("a1")?.mode).toBe("hidden");
    expect(toolPlan("fail")?.mode).toBe("normal");
    expect(toolPlan("b0")?.mode).toBe("normal");
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
