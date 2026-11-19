import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TAIL_LINES,
  FOLD_DISTANCE,
  MAX_FULL_LINES,
  bodyLinesFor,
  detailFor,
  maxRowsFor,
  setTailLines,
  settleLevel,
} from "./detail.ts";
import { groupVerb, mcpLabel, toolMeta, groupNoun, toolTokenLabel } from "./tools.ts";
import { formatDuration, headLines, omittedCount, tailLines } from "./text.ts";
import { groupSegments, renderGroupMember, renderGroupRow } from "./group-row.ts";
import { previewBar, renderToolRow, toolRowLayout } from "./tool-row.ts";
import { thinkingFrame, thinkingLabel, thinkingLayout } from "./thinking.ts";
import { glyphsFor } from "./glyphs.ts";
import { blockDistances, type PlanBlock } from "./layout.ts";
import { advanceTailWindow, isDropping, planTailWindow } from "./window.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";

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

test("elapsed time changes units at one second, one minute and one hour", () => {
  expect([0, 0.4, 4.6, 999, 1000, 7200, 59_400, 60_000, 193_000, 3_599_000, 3_725_000].map(formatDuration)).toEqual([
    "0ms",
    "<1ms",
    "5ms",
    "999ms",
    "1.0s",
    "7.2s",
    "59s",
    "1m 00s",
    "3m 13s",
    "59m 59s",
    "1h 02m",
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
  test("a three-row budget keeps one head row and never spills the tail", () => {
    const lines = ["a", "b", "c", "d", "e"];
    expect(bodyLinesFor(5)).toBe(3);
    const rows = renderToolRow(api, {
      name: "read",
      args: { path: "a.ts" },
      status: "success",
      title: "a.ts",
      output: lines.join("\n"),
      level: 5,
    }).render(80);
    // Level 5 leaves three body rows: head, the notice at the cut, tail.
    expect(rows.length).toBe(4);
    expect(rows[1]).toContain("a");
    expect(rows[2]).toMatch(/\+ 3 lines$/m);
    expect(rows[3]).toContain("e");
  });
});

describe("detail ladder", () => {
  test("distance maps to levels and saturates", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 10].map(detailFor)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7]);
    expect(detailFor(-1)).toBe(0);
  });

  test("row budgets shrink monotonically and never exceed the live cap", () => {
    const rows = ([0, 1, 2, 3, 4, 5, 6, 7] as const).map((level) => maxRowsFor(level));
    expect(rows).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(bodyLinesFor(0)).toBe(8);
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
  test("level 0 renders eight body rows plus a header", () => {
    const lines = renderToolRow(api, { name: "bash", status: "success", level: 0, output: OUTPUT }).render(80);
    expect(lines).toHaveLength(9);
  });

  test("every level sheds exactly one row", () => {
    const rows = ([0, 1, 2, 3, 4, 5, 6, 7] as const).map(
      (level) => renderToolRow(api, { name: "bash", status: "success", level, output: OUTPUT }).render(80).length,
    );
    expect(rows).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  });

  test("level 7 keeps a single output line under the header", () => {
    const lines = renderToolRow(api, { name: "bash", status: "success", level: 7, output: OUTPUT }).render(80);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("line 40");
  });

  test("reads truncate in the middle, keeping head and tail", () => {
    const lines = renderToolRow(api, { name: "read", status: "success", level: 4, output: OUTPUT }).render(80);
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
      const rows = renderToolRow(api, { name: "bash", status: "success", level: 7, output }).render(80);
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
    const input = { phase: "aged", level: 7, width: 80, text: OUTPUT } as const;
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
    expect(label.split("\n").length).toBeLessThanOrEqual(8);
  });

  test("aged level 7 is exactly one line and keeps the last thought", () => {
    const label = thinkingLabel(api, { phase: "aged", level: 7, text: OUTPUT, width: 80, durationMs: 12400 });
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

  test("tools fetched from the web read as web calls", () => {
    expect(toolMeta("fetch_content")).toEqual({ cls: "web", label: "fetch", trend: "head" });
  });

  test("unknown tools fall back to generic", () => {
    expect(toolMeta("some_new_tool").cls).toBe("generic");
  });

  test("group phrases pluralise and read as part of a sentence", () => {
    expect(groupVerb("read", 1)).toBe("read 1 file");
    expect(groupVerb("read", 4)).toBe("read 4 files");
    expect(groupVerb("list", 1)).toBe("listed 1 directory");
    expect(groupVerb("list", 3)).toBe("listed 3 directories");
    expect(groupVerb("shell", 2)).toBe("ran 2 shell commands");
    expect(groupVerb("search", 1)).toBe("searched for 1 pattern");
    expect(groupVerb("search", 3)).toBe("searched for 3 patterns");
    expect(groupNoun("mcp")).toBe("MCP tool");
  });

  test("thinking reads as time when every thought was timed, and as a count otherwise", () => {
    expect(groupVerb("thinking", 3, 220_000)).toBe("thought for 3m 40s");
    expect(groupVerb("thinking", 3)).toBe("thought 3 times");
    expect(groupVerb("shell", 30, 125_000)).toBe("ran 30 shell commands for 2m 05s");
    expect(groupVerb("read", 2, 40)).toBe("read 2 files");
  });

  test("ls lists directories in its own class", () => {
    expect(toolMeta("ls")).toEqual({ cls: "list", label: "ls", trend: "head" });
  });
});
const LONG = "src/modes/interactive/components/assistant-message.js";
const row = (overrides: Parameters<typeof renderToolRow>[1], width: number) =>
  renderToolRow(api, overrides).render(width)[0] ?? "";

const many = (n: number) => Array.from({ length: n }, (_, index) => `out ${index + 1}`).join("\n");

describe("full body budget", () => {
  test("an expanded command and its output share one row cap", () => {
    const command = Array.from({ length: 47 }, (_, index) => `echo step ${index + 1}`).join("\n");
    for (const output of [many(1000), many(380), "done"]) {
      const rows = renderToolRow(api, {
        name: "bash",
        status: "success",
        level: 0,
        expanded: true,
        full: true,
        args: { command },
        output,
      }).render(80);
      expect(rows.length).toBeLessThanOrEqual(1 + MAX_FULL_LINES);
      expect(rows.join("\n")).toContain("echo step 1");
      expect(rows.join("\n")).toContain(output === "done" ? "done" : `out ${output.split("\n").length}`);
    }
  });

  test("a command longer than the cap leaves room for its output", () => {
    const command = Array.from({ length: 900 }, (_, index) => `echo step ${index + 1}`).join("\n");
    const rows = renderToolRow(api, {
      name: "bash",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      args: { command },
      output: many(900),
    }).render(80);
    expect(rows.length).toBe(1 + MAX_FULL_LINES);
    expect(rows.join("\n")).toContain("out 900");
    expect(rows.some((line) => /^ +\+ \d+ lines$/.test(line))).toBe(true);
  });

  test("an expanded row wraps a long line instead of clipping it, within the cap", () => {
    const line = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    for (const [budget, extra] of [
      [{ expanded: true }, maxRowsFor(0, true)],
      [{ expanded: true, full: true }, 1 + MAX_FULL_LINES],
    ] as const) {
      const rows = renderToolRow(api, { name: "bash", status: "success", level: 0, ...budget, output: line }).render(
        40,
      );
      expect(rows.length).toBeGreaterThan(2);
      expect(rows.length).toBeLessThanOrEqual(extra);
      expect(rows.join(" ")).toContain("word39");
      expect(rows.join("")).not.toContain("…");
    }
  });

  test("one enormous line is cut to the cap and says so", () => {
    const rows = renderToolRow(api, {
      name: "read",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      output: "x".repeat(200_000),
    }).render(80);
    expect(rows.length).toBe(1 + MAX_FULL_LINES);
    expect(rows.at(-1)).toEndWith("…");
  });

  test("wrapped rows still keep the end of a tail-trend log", () => {
    const output = Array.from({ length: 300 }, (_, index) => `${index + 1} ${"y".repeat(100)}`).join("\n");
    const rows = renderToolRow(api, {
      name: "bash",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      output,
    }).render(80);
    expect(rows.length).toBeLessThanOrEqual(1 + MAX_FULL_LINES);
    expect(rows).toContain("    300");
    expect(rows.at(-1)).toMatch(/\+ \d+ lines$/);
  });

  test("a preview reports when a line was clipped to the width", () => {
    const long = { name: "bash", status: "success", level: 0, output: "z".repeat(200) } as const;
    expect(toolRowLayout(api, long, 80).clipped).toBe(true);
    expect(toolRowLayout(api, { ...long, output: "short" }, 80).clipped).toBe(false);
    expect(toolRowLayout(api, { ...long, expanded: true, full: true }, 80).clipped).toBe(false);
  });
});

describe("preview bar", () => {
  test("a tail of a long log fills only the bottom of the bar", () => {
    const layout = toolRowLayout(api, { name: "bash", status: "success", level: 0, output: many(160) }, 80);
    expect(layout.bar).toEqual(["track", "track", "track", "track", "track", "track", "track", "fill"]);
    expect(layout.bar).toHaveLength(layout.rows.length - 1);
  });

  test("a read shows its opening and its end as two filled ends", () => {
    const layout = toolRowLayout(api, { name: "read", status: "success", level: 4, output: OUTPUT }, 80);
    expect(layout.bar).toEqual(["fill", "track", "track", "fill"]);
  });

  test("a preview that shows everything is filled, and an open row has no preview bar", () => {
    expect(toolRowLayout(api, { name: "bash", status: "success", level: 0, output: many(3) }, 80).bar).toEqual([
      "fill",
      "fill",
      "fill",
    ]);
    expect(
      toolRowLayout(
        api,
        { name: "bash", status: "success", level: 0, output: many(160), expanded: true, full: true },
        80,
      ).bar,
    ).toBeUndefined();
  });

  test("each cell stands for an equal share of the lines", () => {
    expect(previewBar(10, new Set([4, 5]), 5)).toEqual(["track", "track", "fill", "track", "track"]);
    expect(previewBar(3, new Set([2]), 6)).toEqual(["track", "track", "track", "track", "fill", "fill"]);
  });
});

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

describe("block distances", () => {
  const tool: PlanBlock = { kind: "tool" };
  const prose: PlanBlock = { kind: "prose" };
  const user: PlanBlock = { kind: "user" };

  test("prose ends a group but does not age the blocks before it", () => {
    expect(blockDistances([tool, prose, prose, prose, prose, prose])[0]?.distance).toBe(0);
  });

  test("a user message floors the run before it and starts the next", () => {
    const distances = blockDistances([tool, user, tool]);
    expect(distances[0]).toMatchObject({ distance: FOLD_DISTANCE, currentRun: false });
    expect(distances[2]).toMatchObject({ distance: 0, startsRun: true, currentRun: true });
    expect(distances[0]?.startsRun).toBe(false);
  });

  test("a thought counts its runs and a thought beside prose counts nothing", () => {
    expect(blockDistances([{ kind: "thinking", count: 2 }, tool])[0]?.distance).toBe(1);
    expect(blockDistances([tool, { kind: "thinking", count: 2 }])[0]?.distance).toBe(2);
    const mixed = blockDistances([{ kind: "thinking", withProse: true }, tool, tool, tool, tool, tool, tool]);
    expect(mixed.map((block) => block.distance)).toEqual([FOLD_DISTANCE, 5, 4, 3, 2, 1, 0]);
  });

  test("distances stop at the fold distance", () => {
    const distances = blockDistances(Array.from({ length: 12 }, () => tool));
    expect(distances.map((block) => block.distance)).toEqual([5, 5, 5, 5, 5, 5, 5, 4, 3, 2, 1, 0]);
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
      const perSegment = line.includes("(4 failed)") && line.includes("(1 failed)");
      if (!perSegment) {
        expect(line).toContain("5 failed");
        expect(line).not.toContain("tokens");
        expect(line).not.toContain("1m 33s");
      }
      if (line.includes("tokens") || line.includes("1m 33s")) expect(perSegment).toBe(true);
      if (line.includes("tokens") && !line.includes("1m 33s")) {
        expect(renderGroupRow(api, { ...input, tokens: undefined }).render(width)[0]).toContain("1m 33s");
      }
    }
  });

  test("a wide summary keeps every segment, its failures and the metrics", () => {
    const line = renderGroupRow(api, input).render(120)[0]!;
    expect(line).toMatch(/^▸ Read 4 files, ran 24 shell commands \(4 failed\), edited 2 files \(1 failed\) +· /);
    expect(line).toEndWith("1m 33s");
  });

  test("metrics go before any segment is cut, duration first", () => {
    const title = "▸ Read 4 files, ran 24 shell commands (4 failed), edited 2 files (1 failed)";
    const tokens = renderGroupRow(api, { ...input, durationMs: undefined }).render(120)[0]!;
    const tokensOnly = tokens.slice(tokens.lastIndexOf("·") - 1);
    const line = renderGroupRow(api, input).render(title.length + tokensOnly.length)[0]!;
    expect(line).toStartWith(title);
    expect(line).toContain("tokens");
    expect(line).not.toContain("1m 33s");
    expect(renderGroupRow(api, input).render(title.length + " · 1m 33s".length)[0]).toBe(`${title} · 1m 33s`);
    expect(renderGroupRow(api, input).render(title.length)[0]).toBe(title);
  });

  test("a mixed run reads as one sentence with thinking and shell time", () => {
    const line = renderGroupRow(api, {
      segments: [
        { cls: "thinking", count: 3, durationMs: 220_000 },
        { cls: "search", count: 1 },
        { cls: "list", count: 3 },
        { cls: "shell", count: 30, failed: 4, durationMs: 125_000 },
      ],
    }).render(140)[0];
    expect(line?.trimEnd()).toBe(
      "▸ Thought for 3m 40s, searched for 1 pattern, listed 3 directories, ran 30 shell commands for 2m 05s (4 failed)",
    );
  });

  test("segments total their members' time only when every member was timed", () => {
    expect(
      groupSegments([
        { cls: "thinking", count: 2, durationMs: 1000 },
        { cls: "shell", durationMs: 500 },
        { cls: "thinking", durationMs: 3000 },
        { cls: "shell" },
      ]),
    ).toEqual([
      { cls: "thinking", count: 3, durationMs: 4000 },
      { cls: "shell", count: 2 },
    ]);
  });

  test("a summary without failures truncates as before", () => {
    const line = renderGroupRow(api, {
      segments: [
        { cls: "read", count: 4 },
        { cls: "shell", count: 24 },
      ],
    }).render(16)[0];
    expect(line).toBe("▸ Read 4 files,…");
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
    expect(label.split("\n")[1]?.trim()).toBe("+ 94 lines");
    expect(label.split("\n").at(-1)).toContain("line 99");
  });
});
