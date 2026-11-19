import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_TAIL_LINES, bodyLinesFor, detailFor, maxRowsFor, setTailLines, settleLevel } from "./detail.ts";
import { groupVerb, mcpLabel, toolMeta, groupNoun, toolTokenLabel } from "./tools.ts";
import { formatDuration, headLines, omittedCount, tailLines } from "./text.ts";
import { renderGroupMember, renderGroupRow } from "./group-row.ts";
import { renderToolRow } from "./tool-row.ts";
import { thinkingFrame, thinkingLabel, thinkingLayout } from "./thinking.ts";
import { glyphsFor } from "./glyphs.ts";
import { planTranscript, type BlockShape } from "./layout.ts";
import { advanceTailWindow, isDropping, planTailWindow } from "./window.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";

// Exercise the compact seven-row configuration used by these fixtures.
beforeEach(() => setTailLines(7));
afterEach(() => setTailLines(DEFAULT_TAIL_LINES));

function wrapPlain(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const source of text.split("\n")) {
    let rest = source;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) {
        rows.push(rest.slice(0, width));
        rest = rest.slice(width);
      } else {
        rows.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      }
    }
    rows.push(rest);
  }
  return rows;
}

/** Plain-text stand-ins: the assertions are about row counts, not styling. */
const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") =>
    line.length <= width ? line : line.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis,
  wrap: wrapPlain,
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

test("elapsed time changes units at one second", () => {
  expect([0, 0.4, 4.6, 999, 1000, 7200, 193000].map(formatDuration)).toEqual([
    "0ms",
    "<1ms",
    "5ms",
    "999ms",
    "1.0s",
    "7.2s",
    "193s",
  ]);
});

test("group members reserve two columns for indentation and keep wrapped content inside the terminal", () => {
  const thought = "one two three ".repeat(10);
  for (const width of [40, 80, 120]) {
    const rows = renderGroupMember(kit, width, (innerWidth) =>
      thinkingLabel(api, { phase: "aged", level: 0, text: thought, width: innerWidth, expanded: true }).split("\n"),
    );
    expect(rows[0]).toMatch(/^  ✻ think · +35 tokens$/);
    expect(rows[0]?.length).toBe(width);
    expect(rows.slice(1).every((line) => line.startsWith("      "))).toBe(true);
    expect(rows.every((line) => kit.visibleWidth(line) <= width)).toBe(true);
    expect(
      rows
        .slice(1)
        .map((line) => line.trim())
        .join(" "),
    ).toBe(thought.trim());
  }
});

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
    // Level 4 leaves three body rows: head, the notice at the cut, tail.
    expect(rows.length).toBe(4);
    expect(rows[1]).toContain("a");
    expect(rows[2]).toMatch(/\+ 3 lines$/m);
    expect(rows[3]).toContain("e");
  });
});

describe("detail ladder", () => {
  test("the default keeps five recent blocks and reduces an eight-row preview to four before folding", () => {
    setTailLines(DEFAULT_TAIL_LINES);
    const plan = planTranscript(shapes(12));
    expect(plan[0]?.kind).toBe("group");
    expect(plan.slice(1).map((item) => item.kind === "block" && bodyLinesFor(item.level))).toEqual([4, 5, 6, 7, 8]);
  });
  test("distance maps to levels and saturates", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(detailFor)).toEqual([0, 1, 2, 3, 4, 5, 6, 6]);
    expect(detailFor(-1)).toBe(0);
  });

  test("row budgets shrink monotonically and never exceed the live cap", () => {
    const rows = ([0, 1, 2, 3, 4, 5, 6] as const).map((level) => maxRowsFor(level));
    expect(rows).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect(bodyLinesFor(0)).toBe(7);
  });

  test("errors keep their own rows at the bottom of the ladder", () => {
    // An individual error row includes its header and stderr detail.
    const rows = renderToolRow(api, { name: "bash", status: "error", level: 6, error: "detail\nexit 2" }).render(80);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("exit 2");
    expect(rows[1]).toContain("detail");
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
    expect(body).toEqual(["    line 1", "    line 2", "    + 37 lines", "    line 40"]);
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
    expect(text).toContain("+ 5 lines");
    expect(text).not.toContain("unchanged context one");
  });

  test("written file content is not coloured as a diff", () => {
    const tokens = { ...api, theme: { ...theme, fg: (token: string, text: string) => `<${token}>${text}` } };
    for (const content of ["# Notes\n- first item\n+ second item\n--- \nplain", "@@ not a hunk\n-1\n+1"]) {
      const body = renderToolRow(tokens, {
        name: "write",
        status: "success",
        level: 0,
        args: { path: "notes.md", content },
      })
        .render(80)
        .slice(1);
      expect(body.every((line) => line.includes("<toolOutput>"))).toBe(true);
    }
  });

  test("a pinned row outgrows the ladder but stays finite", () => {
    expect(
      renderToolRow(api, { name: "bash", status: "success", level: 6, expanded: true, output: OUTPUT }).render(80),
    ).toHaveLength(17);
  });

  test("a one-row shell tail prefers content over trailing delimiters", () => {
    for (const [output, preview] of [
      ["setup();\n  return result;\n});\n}", "      return result;"],
      ["{\n}", "    + 2 lines"],
      ["0", "    0"],
    ] as const) {
      const rows = renderToolRow(api, { name: "bash", status: "success", level: 6, output }).render(80);
      expect(rows.slice(1)).toEqual([preview]);
    }
  });

  test("shell rows trend on the tail, read rows on the head", () => {
    const shell = renderToolRow(api, { name: "bash", status: "success", level: 2, output: OUTPUT }).render(80);
    expect(shell.at(-2)).toContain("line 40");
    expect(shell.at(-1)).toMatch(/\+ \d+ lines?$/);
    const read = renderToolRow(api, { name: "read", status: "success", level: 2, output: OUTPUT }).render(80);
    expect(read[1]).toContain("line 1");
  });

  test("a failed shell puts the exit status in the header and stderr in the body", () => {
    const error = "1: ls: node_modules/@earendil-works/: No such file or directory\nCommand exited with code 1";
    const rows = renderToolRow(api, { name: "bash", status: "error", level: 0, error }).render(120);
    expect(rows[0]).toContain("Command exited with code 1");
    expect(rows[0]).not.toContain("No such file or directory");
    expect(rows.slice(1).join("\n")).toContain("No such file or directory");
    expect(rows.slice(1).join("\n")).not.toContain("Command exited with code 1");
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
  test("only hidden thought content offers a toggle at the current width", () => {
    const input = { phase: "aged", level: 0, text: "Everything fits.", width: 80 } as const;
    for (const expanded of [false, true]) {
      expect(thinkingLayout(api, { ...input, expanded }).canToggle).toBe(false);
      expect(thinkingLayout(api, { ...input, expanded, level: 6 }).canToggle).toBe(false);
      expect(thinkingLayout(api, { ...input, expanded, level: 6, width: 15 }).canToggle).toBe(true);
      expect(thinkingLayout(api, { ...input, expanded, text: "wrapped words ".repeat(20), width: 20 }).canToggle).toBe(
        true,
      );
    }
  });

  test("opening a tail excerpt restores the beginning and keeps the preview at the end", () => {
    const input = { phase: "aged", level: 6, width: 80, text: OUTPUT } as const;
    expect(thinkingLabel(api, input)).toContain("… line 40");
    expect(
      thinkingLabel(api, { ...input, expanded: true })
        .split("\n")
        .slice(1),
    ).toEqual(OUTPUT.split("\n").map((line) => "    " + line));
    const long = Array.from({ length: 420 }, (_, i) => `part ${i}`).join("\n");
    const lines = thinkingLabel(api, { ...input, text: long, expanded: true }).split("\n");
    expect(lines).toHaveLength(401);
    expect(lines[1]).toBe("    part 0");
    expect(lines.slice(-2)).toEqual(["    part 419", "    + 21 lines"]);
  });

  test("a reported reasoning count and legacy turn timing are identified in the header", () => {
    const label = thinkingLabel(api, {
      phase: "done",
      level: 0,
      text: "done",
      width: 80,
      reasoningTokens: 17,
      durationMs: 3200,
      turnDuration: true,
    });
    expect(label.split("\n")[0]).toMatch(/^✻ think · +17 tokens · 3.2s turn$/);
  });

  test("live label stays within the pool of rows", () => {
    const label = thinkingLabel(api, { phase: "thinking", level: 0, text: OUTPUT, width: 80, frame: 3 });
    expect(label.split("\n").length).toBeLessThanOrEqual(7);
  });

  test("aged level 6 is exactly one line and keeps the last thought", () => {
    const label = thinkingLabel(api, { phase: "aged", level: 6, text: OUTPUT, width: 80, durationMs: 12400 });
    expect(label.split("\n")).toHaveLength(1);
    expect(label).toContain("line 40");
    expect(label).toContain("tokens 6.3/s · 12s");
  });

  test("expanded label shows more rows than collapsed", () => {
    const collapsed = thinkingLabel(api, { phase: "aged", level: 1, text: OUTPUT, width: 80 });
    const expanded = thinkingLabel(api, { phase: "aged", level: 1, text: OUTPUT, width: 80, expanded: true });
    expect(expanded.split("\n").length).toBeGreaterThan(collapsed.split("\n").length);
  });

  test("a streaming thought truncates each line and keeps a stable row count", () => {
    const long = `word ${"tokens ".repeat(120)}`;
    const label = thinkingLabel(api, { phase: "thinking", level: 0, text: long, width: 40 });
    const lines = label.split("\n");
    // Truncation keeps one terminal row per source line, so arriving tokens
    // extend the last row instead of reflowing the tail.
    expect(lines).toHaveLength(2);
    expect(label).toContain("…");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
  });

  test("a settled thought wraps instead of ending in an ellipsis", () => {
    const long = Array.from({ length: 120 }, (_, index) => `word${index % 7}`).join(" ");
    const label = thinkingLabel(api, { phase: "aged", level: 0, text: long, width: 40 });
    expect(label).not.toContain("…");
    for (const line of label.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
  });

  test("a decayed thought says how many lines it hid", () => {
    const text = Array.from({ length: 10 }, (_, index) => `thought ${index + 1}`).join("\n");
    const label = thinkingLabel(api, { phase: "aged", level: 3, text, width: 80 });
    expect(label.split("\n").at(-1)).toContain("+ 7 lines");
    expect(label).toContain("thought 10");
    const expanded = thinkingLabel(api, { phase: "aged", level: 3, text, width: 80, expanded: true });
    expect(expanded).not.toMatch(/\+ \d+ lines?$/m);
    expect(expanded).toContain("thought 1");
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
      { name: "read", status: "success", level: 0, title: LONG, summary: "1 match", durationMs: 400 },
      120,
    );
    expect(head).toContain(LONG);
    expect(head).toContain("1 match");
    expect(head).toContain("400ms");
  });

  test("narrow headers reserve room for the duration", () => {
    const head = row(
      { name: "bash", status: "success", level: 0, title: "bun test", summary: "4 tests", durationMs: 1200 },
      28,
    );
    expect(head).not.toContain("4 tests");
    expect(head).toContain("1.2s");
    expect(head).not.toContain("…");
  });

  test("running bash keeps its elapsed time beside a long command", () => {
    const head = row({ name: "bash", status: "running", level: 0, title: `cat ${LONG}`, durationMs: 7200 }, 40);
    expect(head).toContain("cat ");
    expect(head).toContain("…");
    expect(head).toEndWith("7.2s");
    expect(head.length).toBeLessThanOrEqual(40);
  });

  test("a long title keeps its basename instead of a clipped tail", () => {
    const head = row(
      { name: "read", status: "success", level: 0, title: LONG, summary: "1 match", durationMs: 400 },
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

  test("control sequences in a tool name, title, summary or error never reach the terminal", () => {
    const hostile = "\x1b]0;owned\x07\x1b[2J\x1b[31mred\x1b[0m\ttab\u009b1m\r\nnext";
    const inputs = [
      { name: `tool${hostile}`, status: "success", level: 0 },
      { name: "read", status: "success", level: 0, title: hostile, summary: hostile },
      { name: "read", status: "success", level: 0, args: { path: hostile } },
      { name: "read", status: "error", level: 0, error: hostile },
      { name: "bash", status: "error", level: 0, args: { command: hostile }, error: `stderr\n${hostile}` },
      { name: "bash", status: "success", level: 0, expanded: true, args: { command: `${hostile} ${LONG}` } },
    ] as const;
    for (const input of inputs) {
      for (const line of renderToolRow(api, input).render(120)) {
        // pi-tui measures tabs itself; every other control character must be gone.
        // oxlint-disable-next-line no-control-regex -- asserting their absence
        expect(line).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/);
      }
    }
  });

  test("an estimated prefill rate is marked as approximate", () => {
    expect(toolTokenLabel(26, 5500, { outputRate: 73, inputRate: 2500 })).toBe("out 26 @ 73/s · in 5.5k @ 2.5k/s");
    expect(toolTokenLabel(26, 5500, { outputRate: 73, inputRate: 2500, inputRateEstimated: true })).toBe(
      "out 26 @ 73/s · in 5.5k @ ~2.5k/s",
    );
    const head = row(
      { name: "read", status: "success", level: 0, title: "a.ts", inputRate: 2500, inputRateEstimated: true },
      80,
    );
    expect(head).toContain("@ ~2.5k/s");
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
    expect(plan[0]).toEqual({ kind: "group", segments: [{ cls: "read", count: 6 }], indices: [0, 1, 2, 3, 4, 5] });
    expect(plan.slice(1)).toEqual([
      { kind: "block", index: 6, level: 3 },
      { kind: "block", index: 7, level: 2 },
      { kind: "block", index: 8, level: 1 },
      { kind: "block", index: 9, level: 0 },
    ]);
  });

  test("three preview lines and the omission notice survive immediately before grouping", () => {
    const plan = planTranscript(shapes(5));
    expect(plan[0]?.kind).toBe("group");
    expect(plan[1]).toEqual({ kind: "block", index: 1, level: 3 });
    expect(bodyLinesFor(3)).toBe(4);
  });

  test("folded command totals include failures and identify their count", () => {
    const blocks = Array.from({ length: 28 }, (): BlockShape => ({ cls: "shell" }));
    for (const index of [0, 3, 12, 23]) blocks[index]!.failed = true;
    const [group] = planTranscript(blocks);
    if (group?.kind !== "group") throw new Error("expected folded commands");
    expect(group.indices).toEqual(Array.from({ length: 24 }, (_, index) => index));
    expect(renderGroupRow(api, group).render(80)[0]).toContain("Ran 24 commands (4 failures)");
  });

  test("recent failures keep their own line until old enough to fold", () => {
    const blocks: BlockShape[] = shapes(4);
    blocks[1] = { cls: "edit", failed: true };
    const plan = planTranscript(blocks);
    expect(plan).toEqual(([3, 2, 1, 0] as const).map((level, index) => ({ kind: "block" as const, index, level })));
  });

  test("prose never decays and thinking bottoms out at one line", () => {
    const plan = planTranscript([...shapes(2, "thinking"), ...shapes(3, "prose")]);
    expect(plan.map((item) => (item.kind === "block" ? item.level : "group"))).toEqual(["group", 3, 0, 0, 0]);
  });

  test("groups merge counts by class in encounter order", () => {
    const plan = planTranscript([...shapes(9, "read"), { cls: "edit" }, ...shapes(9, "read")]);
    expect(plan[0]).toEqual({
      kind: "group",
      segments: [
        { cls: "read", count: 14 },
        { cls: "edit", count: 1 },
      ],
      indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    });
  });
});

describe("group summary width", () => {
  const segments = [
    { cls: "read", count: 4 },
    { cls: "shell", count: 24, failed: 4 },
    { cls: "edit", count: 2, failed: 1 },
  ] as const;
  const input = { segments: [...segments], tokens: { outputTokens: 1200, inputTokens: 48000 }, durationMs: 93000 };

  test("failure counts outlast the metrics at every width", () => {
    for (let width = 12; width <= 120; width++) {
      const line = renderGroupRow(api, input).render(width)[0]!;
      expect(line.length).toBeLessThanOrEqual(width);
      const perSegment = line.includes("(4 failures)") && line.includes("(1 failure)");
      if (!perSegment) {
        expect(line).toContain("5 failed");
        expect(line).not.toContain("tokens");
        expect(line).not.toContain("93s");
      }
      if (line.includes("tokens") || line.includes("93s")) expect(perSegment).toBe(true);
      if (line.includes("tokens") && !line.includes("93s")) {
        expect(renderGroupRow(api, { ...input, tokens: undefined }).render(width)[0]).toContain("93s");
      }
    }
  });

  test("a wide summary keeps every segment, its failures and the metrics", () => {
    const line = renderGroupRow(api, input).render(120)[0]!;
    expect(line).toMatch(/^▸ Read 4 files · Ran 24 commands \(4 failures\) · Edited 2 files \(1 failure\) +· /);
    expect(line).toEndWith("93s");
  });

  test("metrics go before any segment is cut, duration first", () => {
    const title = "▸ Read 4 files · Ran 24 commands (4 failures) · Edited 2 files (1 failure)";
    const tokens = renderGroupRow(api, { ...input, durationMs: undefined }).render(120)[0]!;
    const tokensOnly = tokens.slice(tokens.lastIndexOf("·") - 1);
    const line = renderGroupRow(api, input).render(title.length + tokensOnly.length)[0]!;
    expect(line).toStartWith(title);
    expect(line).toContain("tokens");
    expect(line).not.toContain("93s");
    expect(renderGroupRow(api, input).render(title.length + 6)[0]).toBe(`${title} · 93s`);
    expect(renderGroupRow(api, input).render(title.length)[0]).toBe(title);
  });

  test("a summary without failures truncates as before", () => {
    const line = renderGroupRow(api, {
      segments: [
        { cls: "read", count: 4 },
        { cls: "shell", count: 24 },
      ],
    }).render(16)[0];
    expect(line).toBe("▸ Read 4 files …");
  });
});

describe("streaming thinking preview", () => {
  test("bursts show the newest line immediately and replace one stale row per tick", () => {
    let window = planTailWindow(100, 5, planTailWindow(5, 5));
    expect(window.rows).toEqual([0, 1, 2, 3, 99]);
    while (isDropping(window)) {
      const next = advanceTailWindow(window);
      expect(next.rows.filter((index) => !window.rows.includes(index))).toHaveLength(1);
      expect(next.rows.at(-1)).toBe(99);
      window = next;
    }
    expect(window.rows).toEqual([95, 96, 97, 98, 99]);
    expect(planTailWindow(2, 5, window).rows).toEqual([0, 1]);
  });
  test("an expanded clipped line can collapse even when its wrapped text fits the budget", () => {
    const input = { phase: "thinking" as const, level: 0 as const, text: "hello world ".repeat(5), width: 40 };
    expect(thinkingLayout(api, input).canToggle).toBe(true);
    expect(thinkingLayout(api, { ...input, expanded: true }).canToggle).toBe(true);
  });
  test("only visible streaming rows are formatted and omissions count the whole thought", () => {
    const input = {
      phase: "thinking" as const,
      level: 0 as const,
      text: Array.from({ length: 100 }, (_, i) => "line " + i).join("\n"),
      width: 40,
    };
    const frame = thinkingFrame(api, input);
    expect(frame.rows).toHaveLength(frame.keep);
    const label = thinkingLabel(api, input);
    expect(label.split("\n")[1]?.trim()).toBe("+ 95 lines");
    expect(label.split("\n").at(-1)).toContain("line 99");
  });
});
