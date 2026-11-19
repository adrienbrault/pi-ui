import { beforeEach, describe, expect, test } from "bun:test";
import { bodyLinesFor, FOLD_DISTANCE, FORMING_ROWS } from "../render/detail.ts";
import { blockDistances, type PlanBlock } from "../render/layout.ts";
import type { GroupClass } from "../render/tools.ts";
import {
  type FoldUnit,
  joinsOpenGroup,
  keepGroupOpen,
  planFolds,
  resetFolds,
  setGroupOpen,
  thinkingPlan,
  toolPlan,
} from "./fold.ts";

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

const older = (key: string, distance: number): FoldUnit => ({ ...unit("tool", key, distance), currentRun: false });

/** Folded tool units of the current run, oldest first. */
const folded = (count: number, prefix = "f") =>
  Array.from({ length: count }, (_, index) => unit("tool", `${prefix}${index}`, FOLD_DISTANCE + count - index));

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
    // An earlier run: its group no longer forms.
    planFolds([older("a0", 9), older("a1", 8)]);
    const group = toolPlan("a0")?.group;
    expect(group?.open).toBe(false);
    setGroupOpen(group!, true);
    planFolds([older("a0", 9), older("a1", 8)]);
    expect(toolPlan("a0")?.group?.open).toBe(true);
  });
});

describe("forming group", () => {
  test("the newest group shows its members until it holds more than five rows", () => {
    planFolds(folded(FORMING_ROWS));
    expect(toolPlan("f0")?.group).toMatchObject({ forming: true, open: true });
    planFolds(folded(FORMING_ROWS + 1));
    expect(toolPlan("f0")?.group).toMatchObject({ forming: false, open: false });
  });

  test("a thought counts one row per run", () => {
    planFolds([{ ...unit("thinking", "t", 9), count: 3 }, ...folded(2)]);
    expect(toolPlan("f0")?.group?.forming).toBe(true);
    planFolds([{ ...unit("thinking", "t", 9), count: 4 }, ...folded(2)]);
    expect(toolPlan("f0")?.group?.forming).toBe(false);
  });

  test("only the later of two groups split by a boundary forms", () => {
    planFolds([...folded(2, "a"), { ...unit("tool", "edge", 8), boundary: true }, ...folded(2, "b")]);
    expect(toolPlan("a0")?.group?.forming).toBe(false);
    expect(toolPlan("b0")?.group?.forming).toBe(true);
  });

  test("a user message after a group ends its forming", () => {
    const blocks: PlanBlock[] = [{ kind: "tool" }, { kind: "tool" }, { kind: "user" }];
    const placed = blockDistances(blocks);
    planFolds(
      [0, 1].map((index) => ({
        ...unit("tool", `u${index}`, placed[index]!.distance),
        currentRun: placed[index]!.currentRun,
      })),
    );
    expect(toolPlan("u0")?.group).toMatchObject({ forming: false, open: false });
  });

  test("a group that stops forming invalidates its members", () => {
    const first = folded(2);
    planFolds(first);
    const group = toolPlan("f0")?.group;
    const changed = planFolds([...first, { ...unit("tool", "edge", 8), boundary: true }, ...folded(1, "n")]);
    // The same group, now shown collapsed: its hidden member must render again.
    expect(toolPlan("f0")?.group).toBe(group!);
    expect(group?.forming).toBe(false);
    expect(changed.has(first[1]!.component)).toBe(true);
  });

  test("closing a forming group sticks as it grows", () => {
    planFolds(folded(2));
    setGroupOpen(toolPlan("f0")!.group!, false);
    planFolds(folded(3));
    expect(toolPlan("f0")?.group).toMatchObject({ forming: true, open: false });
  });

  test("opening a member keeps its group open past six rows", () => {
    planFolds(folded(2));
    keepGroupOpen(toolPlan("f0")!.group!);
    planFolds(folded(FORMING_ROWS + 3));
    expect(toolPlan("f0")?.group).toMatchObject({ forming: false, open: true });
  });

  test("merging an open and a closed group opens the result", () => {
    planFolds([...folded(2, "a"), { ...unit("tool", "edge", 8), boundary: true }, ...folded(2, "b")]);
    setGroupOpen(toolPlan("a0")!.group!, true);
    setGroupOpen(toolPlan("b0")!.group!, false);
    planFolds([...folded(2, "a"), unit("tool", "edge", 8), ...folded(2, "b")]);
    expect(toolPlan("b1")?.group?.members).toHaveLength(5);
    expect(toolPlan("b1")?.group?.open).toBe(true);
  });

  test("a block joins a forming group while the group still fits five rows with it", () => {
    const joiner = unit("tool", "joiner", FOLD_DISTANCE - 1);
    expect(joinsOpenGroup([...folded(4), joiner], 4)).toBe(true);
    expect(joinsOpenGroup([...folded(5), joiner], 5)).toBe(false);
    expect(joinsOpenGroup([...folded(5), { ...joiner, startsRun: true }], 5)).toBe(true);
    expect(joinsOpenGroup([...folded(2), { ...joiner, currentRun: false }], 2)).toBe(false);
  });

  test("a block joining a group the user closed folds through its heading; one the user opened lists it", () => {
    const joiner = unit("tool", "joiner", FOLD_DISTANCE - 1);
    planFolds(folded(2));
    setGroupOpen(toolPlan("f0")!.group!, false);
    expect(joinsOpenGroup([...folded(2), joiner], 2)).toBe(false);
    setGroupOpen(toolPlan("f0")!.group!, true);
    expect(joinsOpenGroup([...folded(5), joiner], 5)).toBe(true);
  });
});
