import { describe, expect, test } from "bun:test";
import {
  COMPACT_LEVEL,
  FOLD_DISTANCE,
  MAX_FULL_LINES,
  bodyLinesFor,
  detailFor,
  maxRowsFor,
  settleLevel,
} from "./detail.ts";
import { groupVerb, mcpLabel, toolMeta, groupNoun, toolTokenLabel } from "./tools.ts";
import { formatDuration, headLines, nonEmptyLineCount, omittedCount, tailLines } from "./text.ts";
import { groupSegments, renderGroupMember, renderGroupRow } from "./group-row.ts";
import {
  leavingRow,
  previewBar,
  previewText,
  renderToolRow,
  toolHeader,
  toolRowLayout,
  type ToolRowInput,
} from "./tool-row.ts";
import {
  thinkingFrame,
  thinkingKeep,
  thinkingLabel,
  thinkingLayout,
  thinkingLeavingRow,
  type ThinkingLabelInput,
} from "./thinking.ts";
import { glyphsFor } from "./glyphs.ts";
import { blockDistances, type PlanBlock } from "./layout.ts";
import { advanceTailWindow, isDropping, planTailWindow } from "./window.ts";
import { cutMark, type RenderKit, type RenderTheme } from "./kit.ts";
import { memberColumns, metricColumns } from "./columns.ts";

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
    const rows = renderGroupMember(
      kit,
      width,
      (innerWidth) =>
        thinkingLabel(api, { phase: "aged", level: 0, text: thought, width: innerWidth, expanded: true }).split("\n"),
      "…",
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
    expect(rows[2]).toMatch(/⋮  3 more lines$/m);
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
    expect(body).toEqual(["     1  line 1", "     2  line 2", "     ⋮  37 more lines", "    40  line 40"]);
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
    expect(text).toContain("⋮  5 more lines");
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
      ["{\n}", "    ↓ 2 more lines"],
      ["0", "    0"],
    ] as const) {
      const rows = renderToolRow(api, { name: "bash", status: "success", level: 7, output }).render(80);
      expect(rows.slice(1)).toEqual([preview]);
    }
  });

  test("shell rows trend on the tail, read rows on the head", () => {
    const shell = renderToolRow(api, { name: "bash", status: "success", level: 2, output: OUTPUT }).render(80);
    // The hidden lines are above the tail, so the notice heads the body.
    expect(shell[1]).toMatch(/↑ \d+ more lines?$/);
    expect(shell.at(-1)).toContain("line 40");
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

const numbered = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => `line ${from + index}`).join("\n");

const readRow = (output: string, args: Record<string, unknown> = {}, extra: Partial<ToolRowInput> = {}) =>
  renderToolRow(api, { name: "read", status: "success", level: 0, args: { path: "a.ts", ...args }, output, ...extra });

/** A shell row's body rows. */
const shell = (command: string, output: string) =>
  renderToolRow(api, { name: "bash", status: "success", level: 0, args: { command }, output }).render(80).slice(1);

describe("line numbers", () => {
  test("a read numbers its lines from 1, right-aligned in front of the code", () => {
    expect(readRow("alpha\nbeta\ngamma").render(80).slice(1)).toEqual(["    1  alpha", "    2  beta", "    3  gamma"]);
  });

  test("a read from offset 400 numbers from 400, and a skipped blank line keeps its number", () => {
    expect(readRow("first\n\nthird", { offset: 400 }).render(80).slice(1)).toEqual([
      "    400  first",
      "    402  third",
    ]);
  });

  test("the numbers show the jump across the omission notice", () => {
    const body = readRow(numbered(21, 400), { offset: 400 }, { level: 4 }).render(80).slice(1);
    expect(body).toEqual(["    400  line 400", "    401  line 401", "      ⋮  18 more lines", "    420  line 420"]);
  });

  test("numbers align to the widest one shown", () => {
    const nine = readRow(numbered(10), {}, { expanded: true, full: true }).render(80).slice(1);
    expect(nine[0]).toBe("     1  line 1");
    expect(nine[8]).toBe("     9  line 9");
    expect(nine[9]).toBe("    10  line 10");
    const hundred = readRow(numbered(6, 95), { offset: 95 }).render(80).slice(1);
    expect(hundred[0]).toBe("     95  line 95");
    expect(hundred[4]).toBe("     99  line 99");
    expect(hundred[5]).toBe("    100  line 100");
  });

  test("an opened read wraps a long line under the code column, with a blank gutter", () => {
    const long = "word ".repeat(12).trim();
    const rows = readRow(`short\n${long}`, {}, { expanded: true, full: true }).render(40).slice(1);
    expect(rows[0]).toBe("    1  short");
    expect(rows[1]).toBe("    2  word word word word word word");
    expect(rows[2]).toBe("       word word word word word word");
    expect(rows.every((row) => row.length <= 40)).toBe(true);
  });

  test("a preview cuts its code at the width left beside the gutter", () => {
    const rows = readRow("x".repeat(60)).render(40).slice(1);
    expect(rows[0]).toBe(`    1  ${"x".repeat(30)} … `);
    expect(rows[0]).toHaveLength(40);
  });

  test("a narrow row drops the gutter for the whole block", () => {
    // Inner width 23 leaves 20 columns of code beside a three-column gutter: kept.
    expect(readRow("alpha\nbeta").render(27).slice(1)).toEqual(["    1  alpha", "    2  beta"]);
    // Inner width 22 would leave 19: the block shows code only.
    expect(readRow("alpha\nbeta").render(26).slice(1)).toEqual(["    alpha", "    beta"]);
  });

  test("the gutter is dim, the code keeps its own colour", () => {
    const tokens = { ...api, theme: { ...theme, fg: (token: string, text: string) => `<${token}>${text}` } };
    const rows = renderToolRow(tokens, { name: "read", status: "success", level: 0, output: "alpha" }).render(80);
    expect(rows[1]).toBe("    <dim>1  <toolOutput>alpha");
  });

  test("a failed read, an image read and pi's long-line notice carry no numbers", () => {
    const failed = renderToolRow(api, { name: "read", status: "error", level: 0, error: "ENOENT: no such file" });
    expect(failed.render(80).slice(1)).toEqual(["    ENOENT: no such file"]);
    expect(readRow("Read image file [image/png]").render(80).slice(1)).toEqual(["    Read image file [image/png]"]);
    const long = "[Line 3 is 80.0KB, exceeds 50.0KB limit. Use bash: sed -n '3p' a.ts | head -c 51200]";
    expect(readRow(long).render(200).slice(1)).toEqual([`    ${long}`]);
  });

  test("sed and cat of one file number from their first line", () => {
    expect(shell("sed -n '120,122p' src/a.ts", "one\ntwo\nthree")).toEqual([
      "    120  one",
      "    121  two",
      "    122  three",
    ]);
    expect(shell("sed -n 7p src/a.ts", "seven")).toEqual(["    7  seven"]);
    expect(shell("cd pkg && cat src/a.ts", "one\ntwo")).toEqual(["    1  one", "    2  two"]);
    // A pipeline is not a file range, and a truncated shell output keeps its tail, not its start.
    expect(shell("cat src/a.ts | sort", "one\ntwo")).toEqual(["    one", "    two"]);
    const truncated = "late\n\n[Showing lines 1999-2000 of 2000. Full output: /tmp/pi-bash.log]";
    expect(shell("cat src/a.ts", truncated)[0]).toBe("    late");
    // While running, pi sends the tail of the output so far without saying so.
    const running = renderToolRow(api, {
      name: "bash",
      status: "running",
      level: 0,
      args: { command: "cat a.ts" },
      output: "one",
    });
    expect(running.render(80)[1]).toBe("    one");
  });
});

/** An opened edit row's body rows, trailing background padding trimmed. */
const editBody = (output: string, width = 80) =>
  renderToolRow(api, { name: "edit", status: "success", level: 0, expanded: true, full: true, output })
    .render(width)
    .slice(1)
    .map((row) => row.trimEnd());

describe("diff line numbers", () => {
  test("a patch numbers removed lines in the old file, added and unchanged ones in the new", () => {
    const patch = [
      "--- a.ts",
      "+++ a.ts",
      "@@ -9,3 +9,4 @@",
      " keep nine",
      "-old ten",
      "+new ten",
      "+new eleven",
      " keep",
      "@@ -40,2 +41,2 @@",
      "-gone",
      "+came",
      " tail",
    ].join("\n");
    expect(editBody(patch)).toEqual([
      "    --- a.ts",
      "    +++ a.ts",
      "    @@ -9,3 +9,4 @@",
      "     9   keep nine",
      "    10  -old ten",
      "    10  +new ten",
      "    11  +new eleven",
      "    12   keep",
      "    @@ -40,2 +41,2 @@",
      "    40  -gone",
      "    41  +came",
      "    42   tail",
    ]);
  });

  test("a removed line that reads like a file header still takes its number", () => {
    expect(editBody("@@ -1,2 +1,1 @@\n--- a comment\n-two\n+one")).toEqual([
      "    @@ -1,2 +1,1 @@",
      "    1  --- a comment",
      "    2  -two",
      "    1  +one",
    ]);
  });

  test("pi's numbered diff moves its numbers into the gutter", () => {
    const diff = ["  9 a", "-10 b", "+10 B", " 11 c", "    ...", " 20 d"].join("\n");
    expect(editBody(diff)).toEqual([
      "     9   a",
      "    10  -b",
      "    10  +B",
      "    11   c",
      "        ...",
      "    20   d",
    ]);
    // Too narrow for the gutter: the signs stay, the numbers go.
    expect(editBody(diff, 26).slice(0, 2)).toEqual(["     a", "    -b"]);
  });

  test("a preview keeps the evidence numbered and its notice at the gutter column", () => {
    const patch = ["@@ -1,6 +1,6 @@", " one", " two", "-three", "+THREE", " four", " five"].join("\n");
    const rows = renderToolRow(api, { name: "edit", status: "success", level: 3, output: patch })
      .render(80)
      .slice(1)
      .map((row) => row.trimEnd());
    expect(rows).toEqual(["    @@ -1,6 +1,6 @@", "    3  -three", "    3  +THREE", "    ⋮  4 more lines"]);
  });

  test("a shell diff keeps its text as it came", () => {
    const rows = shell("git diff", "@@ -9,1 +9,1 @@\n-old\n+new");
    expect(rows).toEqual(["    @@ -9,1 +9,1 @@", "    -old", "    +new"]);
  });
});

/** A read's layout at 80 columns. */
const trailed = (output: string, extra: Partial<ToolRowInput> = {}) =>
  toolRowLayout(api, { name: "read", status: "success", level: 0, args: { path: "a.ts" }, output, ...extra }, 80);

describe("pi's read trailer", () => {
  const more = "\n\n[121 more lines in file. Use offset=4 to continue.]";

  test("the continuation note is a notice below the code, not a numbered line", () => {
    const layout = trailed(`alpha\nbeta\ngamma${more}`);
    expect(layout.rows.slice(1)).toEqual([
      "    1  alpha",
      "    2  beta",
      "    3  gamma",
      "    ↓  121 more lines in file",
    ]);
    expect(layout.sources).toEqual([0, 1, 2, undefined]);
    // Nothing is hidden that opening the row would show.
    expect(layout.omission).toBeUndefined();
    expect(nonEmptyLineCount(previewText({ name: "read", output: `alpha\nbeta\ngamma${more}` }))).toBe(3);
  });

  test("pi's truncation notes count the lines left in the file", () => {
    for (const note of [
      "[Showing lines 1-3 of 124. Use offset=4 to continue.]",
      "[Showing lines 1-3 of 124 (50.0KB limit). Use offset=4 to continue.]",
    ]) {
      expect(trailed(`alpha\nbeta\ngamma\n\n${note}`).rows.at(-1)).toBe("    ↓  121 more lines in file");
    }
  });

  test("the notice takes its row from the budget before the code is chosen", () => {
    const layout = trailed(numbered(40) + more, { level: 4 });
    expect(layout.rows.slice(1)).toEqual([
      "     1  line 1",
      "     ⋮  38 more lines",
      "    40  line 40",
      "     ↓  121 more lines in file",
    ]);
    expect(layout.omission).toBe(2);
    // Each level drops the line the next level would drop without the notice.
    const thirty = { name: "read", status: "success", args: { path: "a.ts" }, output: numbered(30) } as const;
    expect(leavingAt({ ...thirty, output: thirty.output + more }).slice(0, 3)).toEqual(leavingAt(thirty).slice(1));
  });

  test("a one-row read keeps its own notice and leaves the file note out", () => {
    expect(trailed(numbered(40) + more, { level: 7 }).rows.slice(1)).toEqual(["    ↓ 40 more lines"]);
  });

  const body = (output: string, level: 5 | 6) => trailed(output + more, { level }).rows.slice(1);

  test("the file note never leaves a read without code", () => {
    // Three rows: one line, the notice for the rest of the read, the note for the rest of the file.
    expect(body(numbered(40), 5)).toEqual(["    1  line 1", "    ↓  39 more lines", "    ↓  121 more lines in file"]);
    // Two rows: the note would leave the code a notice alone, so it gives way.
    expect(body(numbered(40), 6)).toEqual(["    1  line 1", "    ↓  39 more lines"]);
    expect(body("alpha\nbeta", 6)).toEqual(["    1  alpha", "    2  beta"]);
    expect(body("alpha", 6)).toEqual(["    1  alpha", "    ↓  121 more lines in file"]);
  });

  test("an opened read ends with the note", () => {
    const rows = trailed(numbered(12) + more, { expanded: true, full: true }).rows;
    expect(rows).toHaveLength(14);
    expect(rows.at(-2)).toBe("    12  line 12");
    expect(rows.at(-1)).toBe("     ↓  121 more lines in file");
  });

  test("only a read's own trailer is taken out", () => {
    const log = renderToolRow(api, { name: "bash", status: "success", level: 0, output: `alpha${more}` }).render(80);
    expect(log.at(-1)).toBe("    [121 more lines in file. Use offset=4 to continue.]");
    expect(trailed(`[121 more lines in file. Use offset=4 to continue.]\nalpha`).rows.at(-1)).toBe("    2  alpha");
  });
});

const thoughtRows = (input: Partial<ThinkingLabelInput>) =>
  thinkingLayout(api, { phase: "aged", level: 0, text: "Scoping", width: 100, ...input }).label.split("\n").length;

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
    expect(thinkingLabel(api, input)).toMatch(/^✻ think · line 1 line 2 .* … .*line 39 line 40 · /);
    expect(
      thinkingLabel(api, { ...input, expanded: true })
        .split("\n")
        .slice(1),
    ).toEqual(OUTPUT.split("\n").map((line) => "    " + line));
    const long = Array.from({ length: 420 }, (_, i) => `part ${i}`).join("\n");
    const lines = thinkingLabel(api, { ...input, text: long, expanded: true }).split("\n");
    expect(lines).toHaveLength(401);
    expect(lines[1]).toBe("    part 0");
    // The hidden rows sit between the opening and the last row: so does the notice.
    expect(lines.slice(-3)).toEqual(["    part 397", "    ⋮ 21 more lines", "    part 419"]);
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
    expect(label).toMatch(/^✻ think · done · +17 tokens · 3.2s turn$/);
  });

  test("live label stays within the pool of rows", () => {
    const label = thinkingLabel(api, { phase: "thinking", level: 0, text: OUTPUT, width: 80, frame: 3 });
    expect(label.split("\n").length).toBeLessThanOrEqual(8);
  });

  test("a one-row thought that fits whole shows all of it and cannot open", () => {
    const layout = thinkingLayout(api, { phase: "aged", level: 7, text: "first\nlast", width: 80 });
    expect(layout.label).toMatch(/^✻ think · first last · +\d+ tokens$/);
    expect(layout.canToggle).toBe(false);
  });

  test("a settled one-line thought that fits its heading row takes one row at every level", () => {
    for (const level of [0, 3, 5] as const) {
      const layout = thinkingLayout(api, {
        phase: "aged",
        level,
        text: "Scoping latest commit review",
        width: 100,
        durationMs: 5200,
      });
      expect(layout.label.split("\n")).toHaveLength(1);
      expect(layout.label).toMatch(/^✻ think · Scoping latest commit review · +\d+ tokens [^·]+ · 5.2s$/);
      expect(layout.canToggle).toBe(false);
      expect(layout.bar).toBeUndefined();
      expect(thinkingLeavingRow(api, { phase: "aged", level, text: "Scoping latest commit review", width: 100 })).toBe(
        undefined,
      );
    }
  });

  test("a streaming, a multi-line or a too-long thought keeps its body rows", () => {
    const rows = thoughtRows;
    expect(rows({ phase: "thinking" })).toBe(2);
    expect(rows({ text: "one\ntwo" })).toBe(3);
    expect(rows({ text: "word ".repeat(40), width: 60 })).toBeGreaterThan(1);
  });

  test("a one-row thought too long for the row keeps its start and its end", () => {
    for (const width of [80, 120]) {
      const layout = thinkingLayout(api, { phase: "aged", level: 7, text: OUTPUT, width, durationMs: 12400 });
      expect(layout.label).toMatch(/^✻ think · line 1 .* … .*line 40 · +\d+ tokens/);
      expect(layout.label.length).toBe(width);
      expect(layout.canToggle).toBe(true);
    }
    const narrow = thinkingLayout(api, { phase: "aged", level: 7, text: OUTPUT, width: 40, durationMs: 12400 });
    expect(narrow.label).toMatch(/^✻ think · li … 0 · /);
    expect(narrow.label.length).toBe(40);
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
    // A settled thought keeps its newest rows: the hidden ones are above them, and so is the notice.
    expect(label.split("\n")[1]).toContain("↑ 7 more lines");
    expect(label.split("\n").at(-1)).toContain("thought 10");
    const expanded = thinkingLabel(api, { phase: "aged", level: 3, text, width: 80, expanded: true });
    expect(expanded).not.toMatch(/more lines?$/m);
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

const openedCommand = (command: string, width: number, output = "done") =>
  renderToolRow(api, {
    name: "bash",
    status: "success",
    level: 0,
    expanded: true,
    full: true,
    args: { command },
    output,
  }).render(width);

describe("opened command", () => {
  // "● bash · ": the command text starts in this column.
  const column = 9;
  const headOf = (header: string) => {
    const end = header.indexOf(" · ", column);
    return header.slice(column, end < 0 ? undefined : end).trimEnd();
  };

  test("the header carries the command's first segment and the rest continues under its first column", () => {
    const command = `echo ${Array.from({ length: 20 }, (_, index) => `word${index}`).join(" ")}`;
    for (const width of [40, 60, 120]) {
      const rows = openedCommand(command, width);
      expect(rows[0]).toStartWith("● bash · echo word0");
      expect(rows[0]).not.toContain("…");
      const continuation = rows.slice(
        1,
        rows.findIndex((line) => line.trim() === "done"),
      );
      expect(continuation.every((line) => line.startsWith(" ".repeat(column)) && line[column] !== " ")).toBe(true);
      expect([headOf(rows[0]!), ...continuation.map((line) => line.trim())].join(" ")).toBe(command);
      expect(rows.every((line) => line.length <= width)).toBe(true);
    }
  });

  test("each line of a multi-line command starts in the same column", () => {
    const rows = openedCommand("cd /tmp\nls -la", 80, "");
    expect(headOf(rows[0]!)).toBe("cd /tmp");
    expect(rows.slice(1)).toEqual([" ".repeat(column) + "ls -la"]);
  });

  test("an opened header still reports the command a closed one hides", () => {
    const command = "cd /tmp\nls -la";
    const input = { name: "bash", status: "success", level: 0, args: { command } } as const;
    expect(toolHeader(api, input, 80).hiddenCommand).toBe(command);
    expect(toolHeader(api, { ...input, expanded: true, full: true }, 80).hiddenCommand).toBe(command);
  });
});

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
    expect(rows.some((line) => /^ +↓ \d+ more lines$/.test(line))).toBe(true);
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
    expect(rows.at(-1)).toEndWith(" … ");
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
    expect(rows[1]).toMatch(/↑ \d+ more lines$/);
  });

  test("a preview reports when a line was clipped to the width", () => {
    const long = { name: "bash", status: "success", level: 0, output: "z".repeat(200) } as const;
    expect(toolRowLayout(api, long, 80).clipped).toBe(true);
    expect(toolRowLayout(api, { ...long, output: "short" }, 80).clipped).toBe(false);
    expect(toolRowLayout(api, { ...long, expanded: true, full: true }, 80).clipped).toBe(false);
  });
});

const leavingAt = (input: Omit<Parameters<typeof leavingRow>[1], "level">) =>
  ([0, 1, 2, 3] as const).map((level) => leavingRow(api, { ...input, level }, 80));

describe("the row that leaves", () => {
  const thirty = Array.from({ length: 30 }, (_, index) => `L${index + 1}`).join("\n");
  const diff = ["@@ -1,30 +1,30 @@", ...Array.from({ length: 15 }, (_, index) => `-old ${index}\n+new ${index}`)].join(
    "\n",
  );

  test("a read loses the end of its opening, then the start of its end, in turn", () => {
    expect(leavingAt({ name: "read", status: "success", output: thirty })).toEqual([4, 5, 3, 4]);
  });

  test("a diff loses its last evidence row, above the notice", () => {
    expect(leavingAt({ name: "edit", status: "success", output: diff })).toEqual([7, 6, 5, 4]);
  });

  test("a log loses its oldest kept line", () => {
    // Row 1 is the notice above the tail; the oldest kept line is under it.
    expect(leavingAt({ name: "bash", status: "success", output: thirty })).toEqual([2, 2, 2, 2]);
  });

  test("an output that fits loses nothing", () => {
    expect(leavingAt({ name: "bash", status: "success", output: "one\ntwo" })).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("a thought keeps its newest rows, and two levels can keep the same three", () => {
    expect(([0, 1, 2, 3, 4] as const).map(thinkingKeep)).toEqual([6, 5, 4, 3, 3]);
    const input = { phase: "aged", text: thirty, width: 80 } as const;
    // Row 1 is the notice above the kept rows; the oldest kept row is under it.
    expect(([0, 1, 2, 3] as const).map((level) => thinkingLeavingRow(api, { ...input, level }))).toEqual([
      2,
      2,
      2,
      undefined,
    ]);
    const rows = thinkingLabel(api, { ...input, level: 0 }).split("\n");
    expect(rows[2]?.trim()).toBe("L25");
    // With nothing hidden there is no notice, and the oldest row is the first under the heading.
    const fits = { ...input, text: Array.from({ length: 6 }, (_, index) => `L${index + 1}`).join("\n") };
    expect(thinkingLeavingRow(api, { ...fits, level: 0 })).toBe(1);
    expect(thinkingLeavingRow(api, { ...input, text: "short", level: 0 })).toBeUndefined();
  });
});

/** A notice row styled as italic `accent`, under a theme that prints its tokens. */
const styled = (line: string | undefined) =>
  expect(line?.trim()).toMatch(/^<i><thinkingOff>[↑↓⋮] \d+ more lines?<\/thinkingOff><\/i>$/);

describe("omission notices", () => {
  const diff = ["@@ -1,30 +1,30 @@", ...Array.from({ length: 15 }, (_, index) => `-old ${index}\n+new ${index}`)].join(
    "\n",
  );
  const command = Array.from({ length: 900 }, (_, index) => `echo step ${index + 1}`).join("\n");
  const thoughts = Array.from({ length: 10 }, (_, index) => `thought ${index + 1}`).join("\n");
  const long = Array.from({ length: 420 }, (_, i) => `part ${i}`).join("\n");
  /** Every notice row an api renders, trimmed and with its gutter spacing squeezed, in order. */
  const notices = (glyphs: ReturnType<typeof glyphsFor>) => {
    const glyphed = { ...api, glyphs };
    const body = (input: Parameters<typeof renderToolRow>[1]) =>
      renderToolRow(glyphed, input)
        .render(80)
        .map((line) => line.trim().replace(/\s+/g, " "))
        .filter((line) => /more lines?$/.test(line));
    const thought = (input: Parameters<typeof thinkingLabel>[1]) =>
      thinkingLabel(glyphed, input)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /more lines?$/.test(line));
    return {
      tail: body({ name: "bash", status: "success", level: 4, output: OUTPUT }),
      read: body({ name: "read", status: "success", level: 4, output: OUTPUT }),
      readHead: body({ name: "read", status: "success", level: 6, output: OUTPUT }),
      alone: body({ name: "bash", status: "success", level: 7, output: "{\n}" }),
      diff: body({ name: "edit", status: "success", level: 3, output: diff }),
      command: body({ name: "bash", status: "success", level: 0, expanded: true, full: true, args: { command } }),
      settled: thought({ phase: "aged", level: 3, text: thoughts, width: 80 }),
      streaming: thought({ phase: "thinking", level: 3, text: thoughts, width: 80 }),
      opened: thought({ phase: "aged", level: 0, text: long, width: 80, expanded: true }),
    };
  };

  test("a notice names the side its hidden lines are on", () => {
    expect(notices(glyphsFor("unicode"))).toEqual({
      tail: ["↑ 37 more lines"],
      read: ["⋮ 37 more lines"],
      readHead: ["↓ 39 more lines"],
      alone: ["↓ 2 more lines"],
      diff: ["↓ 27 more lines"],
      command: ["↓ 500 more lines"],
      settled: ["↑ 7 more lines"],
      streaming: ["↑ 7 more lines"],
      opened: ["⋮ 21 more lines"],
    });
  });

  test("ASCII glyphs carry the side as ^, v and :", () => {
    const { tail, read, alone, opened } = notices(glyphsFor("ascii"));
    expect([tail, read, alone, opened]).toEqual([
      ["^ 37 more lines"],
      [": 37 more lines"],
      ["v 2 more lines"],
      [": 21 more lines"],
    ]);
  });

  test("one hidden line reads in the singular", () => {
    const label = thinkingLabel(api, { phase: "aged", level: 3, text: "a\nb\nc\nd", width: 80 });
    expect(label.split("\n")[1]?.trim()).toBe("↑ 1 more line");
  });

  test("unchanged context dropped between a diff's changes is marked as between them", () => {
    const small = ["@@ -1,4 +1,4 @@", " context one", "-old", "+new", " context two", " context three"].join("\n");
    const rows = renderToolRow(api, { name: "edit", status: "success", level: 3, output: small }).render(80);
    expect(rows.at(-1)?.trim()).toBe("⋮  3 more lines");
  });

  test("every notice is italic and faint, apart from the grey output", () => {
    const tokens = {
      ...api,
      theme: {
        ...theme,
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
        italic: (text: string) => `<i>${text}</i>`,
      },
    };
    const tail = renderToolRow(tokens, { name: "bash", status: "success", level: 4, output: OUTPUT }).render(80);
    styled(tail[1]);
    expect(tail.at(-1)).toContain("<toolOutput>");
    const opened = renderToolRow(tokens, {
      name: "bash",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      args: { command },
    }).render(80);
    styled(opened.find((line) => line.includes("more lines")));
    styled(thinkingLabel(tokens, { phase: "aged", level: 3, text: thoughts, width: 80 }).split("\n")[1]);
  });
});

describe("preview bar", () => {
  test("a tail of a long log fills only the bottom of the bar", () => {
    const layout = toolRowLayout(api, { name: "bash", status: "success", level: 0, output: many(160) }, 80);
    expect(layout.bar).toEqual(["track", "track", "track", "track", "track", "track", "track", "fill"]);
    expect(layout.bar).toHaveLength(layout.rows.length - 1);
    // The notice heads the tail, beside a track cell; the filled cell sits beside the newest line.
    expect(layout.rows[1]).toMatch(/↑ 153 more lines$/);
    expect(layout.sources?.[0]).toBeUndefined();
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

  test("a settled thought's bar covers its body rows, notice included, and fills where its tail sits", () => {
    const text = Array.from({ length: 10 }, (_, index) => `thought ${index + 1}`).join("\n");
    const layout = thinkingLayout(api, { phase: "aged", level: 3, text, width: 80 });
    const rows = layout.label.split("\n");
    // The notice above three kept lines: ten sources over four cells, the last three shown,
    // so the filled cell sits beside the newest row and the notice's cell is track.
    expect(rows[1]).toContain("↑ 7 more lines");
    expect(rows.at(-1)).toContain("thought 10");
    expect(layout.bar).toEqual(["track", "track", "track", "fill"]);
    expect(layout.bar).toHaveLength(rows.length - 1);
  });

  test("a streaming thought's notice row sits at the top of its bar like any other row", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const layout = thinkingLayout(api, { phase: "thinking", level: 0, text, width: 40 });
    const rows = layout.label.split("\n");
    expect(rows[1]?.trim()).toBe("↑ 94 more lines");
    expect(layout.bar).toEqual(["track", "track", "track", "track", "track", "track", "fill"]);
    expect(layout.bar).toHaveLength(rows.length - 1);
  });

  test("a formatted thought maps its formatted rows", () => {
    const markdown = { ...api, kit: { ...kit, markdown: (text: string, width: number) => wrapPlain(text, width) } };
    const text = Array.from({ length: 12 }, (_, index) => `- item ${index + 1}`).join("\n");
    const layout = thinkingLayout(markdown, { phase: "aged", level: 3, text, width: 80 });
    expect(layout.label).toContain("↑ 9 more lines");
    expect(layout.bar).toEqual(["track", "track", "track", "fill"]);
  });

  test("a thought shown whole is filled; inline and open thoughts have no preview bar", () => {
    const short = "one\ntwo";
    expect(thinkingLayout(api, { phase: "aged", level: 0, text: short, width: 80 }).bar).toEqual(["fill", "fill"]);
    expect(thinkingLayout(api, { phase: "aged", level: 7, text: OUTPUT, width: 80 }).bar).toBeUndefined();
    expect(
      thinkingLayout(api, { phase: "aged", level: 1, text: OUTPUT, width: 80, expanded: true }).bar,
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
    expect(line).toBe("▸ Read 4 file … ");
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
    expect(label.split("\n")[1]?.trim()).toBe("↑ 94 more lines");
    expect(label.split("\n").at(-1)).toContain("line 99");
  });
});

describe("cut mark", () => {
  // A theme whose colours show up as tags in the output; widths ignore the tags.
  const tagged: RenderTheme = {
    fg: (token, text) => `<${token}>${text}</${token}>`,
    bold: (text) => text,
    italic: (text) => text,
    style: (text, options) =>
      options.bold ? `<b:${options.fg}>${text}</b>` : `<${options.fg}>${text}</${options.fg}>`,
  };
  const tags = /<\/?[^>]*>/g;
  const ansiKit: RenderKit = {
    ...kit,
    visibleWidth: (text) => text.replace(tags, "").length,
    truncateToWidth: (line, width, ellipsis = "…") => {
      const plain = line.replace(tags, "");
      if (plain.length <= width) return line;
      const room = width - ellipsis.replace(tags, "").length;
      return `${plain.slice(0, room)}${ellipsis}`;
    },
  };
  const taggedApi = { kit: ansiKit, theme: tagged, glyphs: glyphsFor("unicode") };
  const MARK = "<b:text> … </b>";

  test("is a bold ellipsis in the text colour with a space each side", () => {
    expect(cutMark(tagged)).toBe(MARK);
  });

  test("a command cut in the middle paints each kept side on its own", () => {
    const { line } = toolHeader(
      taggedApi,
      { name: "bash", status: "success", level: 0, args: { command: `echo ${"a".repeat(60)} done` } },
      40,
    );
    expect(line).toMatch(/<accent>echo a+<\/accent><b:text> … <\/b><accent>a* ?done<\/accent>/);
  });

  test("a path keeps its end after the mark", () => {
    const { line } = toolHeader(
      taggedApi,
      { name: "read", status: "success", level: 0, args: { path: `/very/${"deep/".repeat(12)}notes.txt` } },
      40,
    );
    expect(line).toMatch(/<b:text> … <\/b><accent>[a-z/]*notes\.txt<\/accent>/);
  });

  test("a clipped preview line ends with the mark", () => {
    const rows = renderToolRow(taggedApi, {
      name: "bash",
      status: "success",
      level: 0,
      output: "x".repeat(200),
    }).render(40);
    expect(rows[1]).toEndWith(MARK + "</toolOutput>");
  });

  test("an inline thought cut in the middle paints each kept side on its own", () => {
    const text = `${"opening ".repeat(10)}\n${"closing ".repeat(10)}end`;
    const label = thinkingLabel(taggedApi, { phase: "aged", level: COMPACT_LEVEL, text, width: 80 });
    expect(label).toMatch(
      /<thinkingText>opening [a-z ]+<\/thinkingText><b:text> … <\/b><thinkingText>[a-z ]+end<\/thinkingText>/,
    );
  });
});

describe("member columns", () => {
  test("each cell is right-aligned to its column, and a blank cell keeps its width", () => {
    const cells = [
      { label: "think", outValue: "15", outRate: "3.6", duration: "4.2s" },
      { label: "bash", outValue: "9", inValue: "1.2k", inRate: "~840", duration: "900ms" },
    ];
    const columns = memberColumns(cells, (text) => text.length);
    expect(columns).toEqual({ label: 5, outValue: 2, outRate: 3, inValue: 4, inRate: 4, duration: 5 });
    expect(cells.map((cell) => metricColumns(cell, columns))).toEqual([
      "out 15 @ 3.6/s                    ·  4.2s",
      "out  9         · in 1.2k @ ~840/s · 900ms",
    ]);
  });

  test("a group with no input leaves out the input columns", () => {
    const cells = [{ label: "think", outValue: "15", duration: "4.2s" }];
    expect(
      metricColumns(
        cells[0]!,
        memberColumns(cells, (text) => text.length),
      ),
    ).toBe("out 15 · 4.2s");
  });
});
