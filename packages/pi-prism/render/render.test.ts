import { describe, expect, test } from "bun:test";
import { DEFAULT_TAIL_LINES, bodyLinesFor, detailFor, maxRowsFor, setTailLines, settleLevel } from "./detail.ts";
import { groupVerb, mcpLabel, toolMeta, groupNoun } from "./tools.ts";
import { headLines, omittedCount, tailLines } from "./text.ts";
import { renderToolRow } from "./tool-row.ts";
import { thinkingLabel } from "./thinking.ts";
import { glyphsFor } from "./glyphs.ts";
import { planTranscript, type BlockShape } from "./layout.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";

/** Plain-text stand-ins: the assertions are about row counts, not styling. */
const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") =>
    line.length <= width ? line : line.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis,
  visibleWidth: (text) => text.length,
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
};

const theme: RenderTheme = {
  fg: (_token, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  style: (text) => text,
};

const api = { kit, theme, glyphs: glyphsFor("unicode") };

const OUTPUT = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");

describe("head truncation", () => {
  test("a two-row budget keeps one head row and never spills the tail", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const body = bodyLinesFor(1);
    expect(body).toBe(6);
    const rows = renderToolRow(api, {
      name: "read",
      args: { path: "a.ts" },
      status: "success",
      title: "a.ts",
      output: lines.join("\n"),
      level: 4,
    }).render(80);
    // Level 4 leaves three body rows: head, notice, tail.
    expect(rows.length).toBe(4);
    expect(rows[2]).toContain("more lines");
    expect(rows[3]).toContain("e");
  });
});

describe("detail ladder", () => {
  test("distance maps to levels and saturates", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(detailFor)).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
    expect(detailFor(-1)).toBe(0);
  });

  test("row budgets shrink monotonically and never exceed the live cap", () => {
    const rows = ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => maxRowsFor(level));
    expect(rows).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect(bodyLinesFor(0)).toBe(DEFAULT_TAIL_LINES);
  });

  test("errors keep their own rows at the bottom of the ladder", () => {
    // Header plus the error notice: a failure never collapses into a group.
    expect(renderToolRow(api, { name: "bash", status: "error", level: 6, error: "exit 2" }).render(80)).toHaveLength(2);
  });
});

describe("tail budget", () => {
  test("the slider changes every level at once and the ladder still sheds one row", () => {
    setTailLines(11);
    try {
      expect(([0, 1, 2, 3, 4, 5, 6] as const).map((level) => bodyLinesFor(level))).toEqual([11, 10, 9, 8, 7, 6, 5]);
    } finally {
      setTailLines(DEFAULT_TAIL_LINES);
    }
  });
});

describe("hysteresis", () => {
  test("a level change needs two agreeing recomputes", () => {
    expect(settleLevel(undefined, 2, undefined)).toEqual({ level: 2, pending: undefined });
    expect(settleLevel(2, 3, undefined)).toEqual({ level: 2, pending: 3 });
    expect(settleLevel(2, 3, 3)).toEqual({ level: 3, pending: undefined });
    expect(settleLevel(2, 2, 3)).toEqual({ level: 2, pending: undefined });
  });
});

describe("tail and head", () => {
  test("tail keeps the newest lines in reading order", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
  });

  test("head keeps the oldest lines", () => {
    expect(headLines("a\nb\nc\nd", 2)).toEqual(["a", "b"]);
  });

  test("blank lines do not count as content", () => {
    expect(omittedCount("a\n\n\nb", 1)).toBe(1);
  });
});

describe("tool row heights", () => {
  test("level 0 renders seven body rows plus a header", () => {
    const lines = renderToolRow(api, { name: "bash", status: "success", level: 0, output: OUTPUT }).render(80);
    expect(lines).toHaveLength(8);
  });

  test("every level sheds exactly one row", () => {
    const rows = ([0, 1, 2, 3, 4, 5, 6] as const).map(
      (level) => renderToolRow(api, { name: "bash", status: "success", level, output: OUTPUT }).render(80).length,
    );
    expect(rows).toEqual([8, 7, 6, 5, 4, 3, 2]);
  });

  test("level 6 keeps a single output line under the header", () => {
    const lines = renderToolRow(api, { name: "bash", status: "success", level: 6, output: OUTPUT }).render(80);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("line 40");
  });

  test("reads truncate in the middle, keeping head and tail", () => {
    const lines = renderToolRow(api, { name: "read", status: "success", level: 3, output: OUTPUT }).render(80);
    const body = lines.slice(1);
    expect(body[0]).toContain("line 1");
    expect(body.join("\n")).toContain("< ");
    expect(body.at(-1)).toContain("line 40");
  });

  test("diffs drop context lines before they hide changes", () => {
    const diff = [
      "diff --git a/detail.ts b/detail.ts",
      "index 51aa02f..c4e9b71 100644",
      "@@ -1,6 +1,10 @@",
      " unchanged context one",
      " unchanged context two",
      "-export type DetailLevel = 0 | 1 | 2 | 3 | 4;",
      "+export type DetailLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;",
      " unchanged context three",
      "@@ -40,5 +51,9 @@",
      "+export const FOLD_DISTANCE = 8;",
    ].join("\n");
    const body = renderToolRow(api, { name: "edit", status: "success", level: 1, output: diff }).render(80).slice(1);
    const text = body.join("\n");
    expect(text).toContain("DetailLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6");
    expect(text).toContain("FOLD_DISTANCE = 8");
    expect(text).toContain("context lines hidden");
    expect(text).not.toContain("unchanged context one");
    expect(text.startsWith("/**") || text.includes("< ")).toBe(true);
  });

  test("a pinned row outgrows the ladder but stays finite", () => {
    expect(
      renderToolRow(api, { name: "bash", status: "success", level: 6, expanded: true, output: OUTPUT }).render(80),
    ).toHaveLength(17);
  });

  test("shell rows trend on the tail, read rows on the head", () => {
    const shell = renderToolRow(api, { name: "bash", status: "success", level: 2, output: OUTPUT }).render(80);
    expect(shell.at(-1)).toContain("line 40");
    const read = renderToolRow(api, { name: "read", status: "success", level: 2, output: OUTPUT }).render(80);
    expect(read[1]).toContain("line 1");
  });

  test("every row fits the requested width", () => {
    for (const width of [20, 40, 80]) {
      for (const line of renderToolRow(api, { name: "read", status: "success", level: 0, output: OUTPUT }).render(
        width,
      )) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("thinking labels", () => {
  test("live label stays within the pool of rows", () => {
    const label = thinkingLabel(api, { phase: "thinking", level: 0, text: OUTPUT, width: 80, frame: 3 });
    expect(label.split("\n").length).toBeLessThanOrEqual(7);
  });

  test("aged level 6 is exactly one line and keeps the last thought", () => {
    const label = thinkingLabel(api, { phase: "aged", level: 6, text: OUTPUT, width: 80, durationMs: 12400 });
    expect(label.split("\n")).toHaveLength(1);
    expect(label).toContain("line 40");
  });

  test("expanded label shows more rows than collapsed", () => {
    const collapsed = thinkingLabel(api, { phase: "aged", level: 1, text: OUTPUT, width: 80 });
    const expanded = thinkingLabel(api, { phase: "aged", level: 1, text: OUTPUT, width: 80, expanded: true });
    expect(expanded.split("\n").length).toBeGreaterThan(collapsed.split("\n").length);
  });
});

describe("taxonomy", () => {
  test("mcp names collapse to server/tool", () => {
    expect(mcpLabel("mcp__memory__search")).toBe("memory/search");
    expect(toolMeta("mcp__github__create_pr").cls).toBe("mcp");
  });

  test("unknown tools fall back to generic", () => {
    expect(toolMeta("some_new_tool").cls).toBe("generic");
  });

  test("group verbs pluralise", () => {
    expect(groupVerb("read", 1)).toBe("Read 1 file");
    expect(groupVerb("read", 4)).toBe("Read 4 files");
    expect(groupVerb("shell", 2)).toBe("Ran 2 commands");
    expect(groupVerb("search", 3)).toBe("Searched 3 times");
    expect(groupNoun("mcp")).toBe("MCP tool");
  });
});
const LONG = "src/modes/interactive/components/assistant-message.js";
const row = (overrides: Parameters<typeof renderToolRow>[1], width: number) =>
  renderToolRow(api, overrides).render(width)[0] ?? "";

describe("header budget", () => {
  test("a wide header keeps every field", () => {
    const head = row(
      { name: "read", status: "success", level: 0, title: LONG, summary: "181 lines", durationMs: 400 },
      120,
    );
    expect(head).toContain(LONG);
    expect(head).toContain("181 lines");
    expect(head).toContain("0.4s");
  });

  test("narrow headers shed the duration before the summary", () => {
    const head = row(
      { name: "bash", status: "success", level: 0, title: "bun test", summary: "4 lines", durationMs: 1200 },
      28,
    );
    expect(head).toContain("4 lines");
    expect(head).not.toContain("1.2s");
    expect(head).not.toContain("…");
  });

  test("a long title keeps its basename instead of a clipped tail", () => {
    const head = row(
      { name: "read", status: "success", level: 0, title: LONG, summary: "181 lines", durationMs: 400 },
      40,
    );
    expect(head).toContain("assistant-message.js");
    expect(head.endsWith("0.…")).toBe(false);
    expect(head.length).toBe(40);
  });

  test("an error is never dropped for width", () => {
    const head = row({ name: "read", status: "error", level: 3, title: LONG, error: "ENOENT: no such file" }, 40);
    expect(head).toContain("ENOENT");
    expect(head.length).toBeLessThanOrEqual(40);
  });

  test("an MCP label is not repeated as its title", () => {
    const head = row(
      { name: "mcp__memory__search", status: "success", level: 0, title: "memory/search", summary: "3 facts" },
      80,
    );
    expect(head.match(/memory\/search/g)).toHaveLength(1);
  });
});

const shapes = (n: number, cls: "read" | "prose" | "thinking" = "read") => Array.from({ length: n }, () => ({ cls }));

describe("transcript plan", () => {
  test("a folded run becomes one group before the surviving rows", () => {
    const plan = planTranscript(shapes(10));
    expect(plan[0]).toEqual({ kind: "group", segments: [{ cls: "read", count: 2 }], indices: [0, 1] });
    expect(plan.slice(1)).toEqual([
      { kind: "block", index: 2, level: 6 },
      { kind: "block", index: 3, level: 6 },
      { kind: "block", index: 4, level: 5 },
      { kind: "block", index: 5, level: 4 },
      { kind: "block", index: 6, level: 3 },
      { kind: "block", index: 7, level: 2 },
      { kind: "block", index: 8, level: 1 },
      { kind: "block", index: 9, level: 0 },
    ]);
  });

  test("the last body line holds until the run needs the room", () => {
    // Nine blocks: only the oldest is past the fold distance.
    const plan = planTranscript(shapes(9));
    expect(plan[0]).toEqual({ kind: "group", segments: [{ cls: "read", count: 1 }], indices: [0] });
    expect(plan[1]).toEqual({ kind: "block", index: 1, level: 6 });
    expect(plan[2]).toEqual({ kind: "block", index: 2, level: 6 });
    expect(plan[3]).toEqual({ kind: "block", index: 3, level: 5 });
  });

  test("a failure keeps its own line and splits the group", () => {
    const blocks: BlockShape[] = shapes(6);
    blocks[1] = { cls: "edit", failed: true };
    const plan = planTranscript(blocks);
    expect(plan).toEqual([
      { kind: "block", index: 0, level: 5 },
      { kind: "block", index: 1, level: 4 },
      { kind: "block", index: 2, level: 3 },
      { kind: "block", index: 3, level: 2 },
      { kind: "block", index: 4, level: 1 },
      { kind: "block", index: 5, level: 0 },
    ]);
  });

  test("prose never decays and thinking bottoms out at one line", () => {
    const plan = planTranscript([...shapes(2, "thinking"), ...shapes(3, "prose")]);
    expect(plan.map((item) => (item.kind === "block" ? item.level : "group"))).toEqual([4, 3, 0, 0, 0]);
  });

  test("groups merge counts by class in encounter order", () => {
    const plan = planTranscript([...shapes(9, "read"), { cls: "edit" }, ...shapes(9, "read")]);
    expect(plan[0]).toEqual({
      kind: "group",
      segments: [
        { cls: "read", count: 10 },
        { cls: "edit", count: 1 },
      ],
      indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
  });
});
