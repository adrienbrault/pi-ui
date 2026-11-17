import { describe, expect, test } from "bun:test";
import { BODY_LINES, bodyLinesFor, detailFor, maxRowsFor, settleLevel } from "./detail.ts";
import { groupVerb, mcpLabel, toolMeta, groupNoun } from "./tools.ts";
import { headLines, omittedCount, tailLines } from "./text.ts";
import { renderToolRow } from "./tool-row.ts";
import { thinkingLabel } from "./thinking.ts";
import { glyphsFor } from "./glyphs.ts";
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
};

const api = { kit, theme, glyphs: glyphsFor("unicode") };

const OUTPUT = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");

describe("detail ladder", () => {
  test("distance maps to levels and saturates", () => {
    expect([0, 1, 2, 3, 4, 9].map(detailFor)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(detailFor(-1)).toBe(0);
  });

  test("row budgets shrink monotonically and never exceed the live cap", () => {
    const rows = ([0, 1, 2, 3, 4] as const).map((level) => maxRowsFor(level));
    expect(rows).toEqual([7, 5, 3, 1, 1]);
    expect(bodyLinesFor(0)).toBe(BODY_LINES[0]);
  });

  test("errors keep a row at level 4", () => {
    expect(renderToolRow(api, { name: "bash", status: "error", level: 4, error: "exit 2" }).render(80)).toHaveLength(1);
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
  test("level 0 renders six body rows plus a header", () => {
    const lines = renderToolRow(api, { name: "bash", status: "success", level: 0, output: OUTPUT }).render(80);
    expect(lines).toHaveLength(7);
  });

  test("levels 1 and 2 shrink the body", () => {
    expect(renderToolRow(api, { name: "bash", status: "success", level: 1, output: OUTPUT }).render(80)).toHaveLength(
      5,
    );
    expect(renderToolRow(api, { name: "bash", status: "success", level: 2, output: OUTPUT }).render(80)).toHaveLength(
      3,
    );
  });

  test("level 3 is a single line", () => {
    expect(renderToolRow(api, { name: "bash", status: "success", level: 3, output: OUTPUT }).render(80)).toHaveLength(
      1,
    );
  });

  test("level 4 is folded away unless pinned", () => {
    expect(renderToolRow(api, { name: "bash", status: "success", level: 4, output: OUTPUT }).render(80)).toHaveLength(
      0,
    );
    expect(
      renderToolRow(api, { name: "bash", status: "success", level: 4, expanded: true, output: OUTPUT }).render(80),
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

  test("aged level 3 is exactly one line and keeps the last thought", () => {
    const label = thinkingLabel(api, { phase: "aged", level: 3, text: OUTPUT, width: 80, durationMs: 12400 });
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
