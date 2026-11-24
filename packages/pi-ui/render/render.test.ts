import { describe, expect, test } from "bun:test";
import {
  BLOCKS_PER_STEP,
  COMPACT_LEVEL,
  FOLD_DISTANCE,
  MAX_FULL_LINES,
  bodyLinesFor,
  detailFor,
  imageRowsFor,
  MIN_IMAGE_ROWS,
  maxRowsFor,
  settleLevel,
} from "./detail.ts";
import {
  groupVerb,
  HEADER_MARGIN,
  MIN_RATE_TOKENS,
  mcpLabel,
  describeCall,
  sessionCommand,
  sessionPath,
  toolMeta,
  groupNoun,
  toolTokenLabel,
} from "./tools.ts";
import { formatDuration, headLines, nonEmptyLineCount, omittedCount, tailLines } from "./text.ts";
import { groupSegments, renderGroupMember, renderGroupRow } from "./group-row.ts";
import {
  leavingRow,
  previewBar,
  askOpensUp,
  previewLineCount,
  previewText,
  renderToolRow,
  toolHeader,
  toolRowLayout,
  type FileChanges,
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
import { columnLabelRows, memberColumns, metricColumns } from "./columns.ts";
import { TODOS_PANEL_LINES, todoBar, todosLines, type TodoItem } from "./todos.ts";

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
    expect(rows[0]).toMatch(/^  ✻ think +↓35$/);
    // The heading stops one column short of the edge, where pi draws its scroll bar.
    expect(rows[0]?.length).toBe(width - 1);
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
    // Each level holds for BLOCKS_PER_STEP newer blocks.
    const steps = [0, 1, 2, 3, 4, 5, 6, 7, 10];
    expect(steps.map((step) => detailFor(step * BLOCKS_PER_STEP))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7]);
    expect(steps.map((step) => detailFor((step + 1) * BLOCKS_PER_STEP - 1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7]);
    expect(detailFor(-1)).toBe(0);
    // The fold distance is the first distance past the last standalone level.
    expect(detailFor(FOLD_DISTANCE - 1) + 1).toBe(detailFor(FOLD_DISTANCE));
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
    const body = renderToolRow(api, { name: "edit", status: "success", level: 3, output: diff }).render(80).slice(1);
    const text = body.join("\n");
    expect(text).toContain("DetailLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6");
    expect(text).toContain("FOLD_DISTANCE = 8");
    // Only the three unchanged lines are hidden: the headers were never lines of the file.
    expect(text).toContain("⋮  3 more lines");
    expect(text).not.toContain("unchanged context one");
    expect(text).not.toContain("index 51aa02f");
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
    expect(rows[0]).toContain("exit code 1");
    expect(rows[0]).not.toContain("No such file or directory");
    expect(rows.slice(1).join("\n")).toContain("No such file or directory");
    expect(rows.slice(1).join("\n")).not.toContain("exited with code");
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
    // The last column stays free for pi's scroll bar.
    expect(rows[0]).toBe(`    1  ${"x".repeat(29)} … `);
    expect(rows[0]).toHaveLength(39);
  });

  test("a narrow row drops the gutter for the whole block", () => {
    // Inner width 23 (28 less the scroll bar's column and the indent) leaves 20 columns of code beside a three-column gutter: kept.
    expect(readRow("alpha\nbeta").render(28).slice(1)).toEqual(["    1  alpha", "    2  beta"]);
    // Inner width 22 would leave 19: the block shows code only.
    expect(readRow("alpha\nbeta").render(27).slice(1)).toEqual(["    alpha", "    beta"]);
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
    // The row header names the file and the gutter numbers the lines: file and hunk headers are
    // noise. A faint divider in the number column marks the jump between hunks.
    expect(editBody(patch)).toEqual([
      "     9   keep nine",
      "    10  -old ten",
      "    10  +new ten",
      "    11  +new eleven",
      "    12   keep",
      "     ⋮",
      "    40  -gone",
      "    41  +came",
      "    42   tail",
    ]);
  });

  test("a removed line that reads like a file header still takes its number", () => {
    expect(editBody("@@ -1,2 +1,1 @@\n--- a comment\n-two\n+one")).toEqual([
      "    1  --- a comment",
      "    2  -two",
      "    1  +one",
    ]);
  });

  test("a changed line that reads like a header keeps its change colours and survives a preview", () => {
    const tokens = {
      ...api,
      theme: {
        ...theme,
        style: (text: string, options: { bg?: string }) => (options.bg ? `<${options.bg}>${text}` : text),
      },
    };
    const patch = [
      "--- a.sql",
      "+++ a.sql",
      "@@ -1,8 +1,8 @@",
      " one",
      " two",
      " three",
      "--- old comment",
      "+++ new counter",
      " four",
      " five",
      " six",
    ].join("\n");
    const rows = renderToolRow(tokens, { name: "edit", status: "success", level: 4, output: patch })
      .render(80)
      .slice(1)
      .map((row) => row.trimEnd());
    expect(rows).toEqual([
      "    <toolErrorBg>4  --- old comment",
      "    <toolSuccessBg>4  +++ new counter",
      "    ⋮  6 more lines",
    ]);
  });

  test("pi's numbered diff moves its numbers into the gutter", () => {
    const diff = ["  9 a", "-10 b", "+10 B", " 11 c", "    ...", " 20 d"].join("\n");
    expect(editBody(diff)).toEqual(["     9   a", "    10  -b", "    10  +B", "    11   c", "     ⋮", "    20   d"]);
    // Too narrow for the gutter: the signs stay, the numbers go.
    expect(editBody(diff, 26).slice(0, 2)).toEqual(["     a", "    -b"]);
  });

  test("a preview keeps the evidence numbered and its notice at the gutter column", () => {
    const patch = ["@@ -1,6 +1,6 @@", " one", " two", "-three", "+THREE", " four", " five"].join("\n");
    const rows = renderToolRow(api, { name: "edit", status: "success", level: 3, output: patch })
      .render(80)
      .slice(1)
      .map((row) => row.trimEnd());
    expect(rows).toEqual(["    3  -three", "    3  +THREE", "    ⋮  4 more lines"]);
  });

  test("a shell diff keeps its text as it came", () => {
    const rows = shell("git diff", "@@ -9,1 +9,1 @@\n-old\n+new");
    expect(rows).toEqual(["    @@ -9,1 +9,1 @@", "    -old", "    +new"]);
  });

  test("a shell diff tells its headers from changed lines by the hunk counts, not the prefix", () => {
    const tokens = { ...api, theme: { ...theme, fg: (token: string, text: string) => `<${token}>${text}` } };
    const rows = renderToolRow(tokens, {
      name: "bash",
      status: "success",
      level: 0,
      args: { command: "git diff" },
      output: "--- a/q.sql\n+++ b/q.sql\n@@ -1,1 +1,1 @@\n--- old\n+++ new",
    })
      .render(80)
      .slice(1)
      .map((row) => row.trim());
    expect(rows).toEqual([
      "<dim>--- a/q.sql",
      "<dim>+++ b/q.sql",
      "<accent>@@ -1,1 +1,1 @@",
      "<error>--- old",
      "<success>+++ new",
    ]);
  });

  test("a shell diff cut before its first hunk header still colours its changes by sign", () => {
    const tokens = { ...api, theme: { ...theme, fg: (token: string, text: string) => `<${token}>${text}` } };
    const rows = renderToolRow(tokens, {
      name: "bash",
      status: "success",
      level: 0,
      args: { command: "git diff | tail -n 5" },
      output: "+late\n-early\n@@ -9,1 +9,1 @@\n-c\n+d",
    })
      .render(80)
      .slice(1)
      .map((row) => row.trim());
    expect(rows.slice(0, 2)).toEqual(["<success>+late", "<error>-early"]);
  });

  test("an edit's headers are not lines it could open to show", () => {
    const input = { name: "edit", status: "success", level: 4, output: "--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y" } as const;
    expect(previewLineCount(input)).toBe(2);
    expect(toolRowLayout(api, input, 80).omission).toBeUndefined();
  });
});

/** A read as pi-hashline-edit answers it: the anchor an edit needs, before the code. */
const anchoredRead = (hashes: string[], from = 1) =>
  hashes.map((hash, index) => `${from + index}#${hash}:line ${from + index}`).join("\n");

describe("hashline anchors", () => {
  test("a read drops the anchor standing where the gutter already numbers the line", () => {
    expect(
      readRow(anchoredRead(["ZP", "MQ", "VR"]))
        .render(80)
        .slice(1),
    ).toEqual(["    1  line 1", "    2  line 2", "    3  line 3"]);
  });

  test("a read keeps the code around a line that only looks like an anchor", () => {
    expect(readRow("7#ZP:line").render(80).slice(1)).toEqual(["    1  7#ZP:line"]);
    expect(readRow("1#ZPQMVR:line").render(80).slice(1)).toEqual(["    1  1#ZPQMVR:line"]);
  });

  test("a read from an offset drops anchors that start there", () => {
    expect(
      readRow(anchoredRead(["ZP", "MQ"], 400), { offset: 400 })
        .render(80)
        .slice(1),
    ).toEqual(["    400  line 400", "    401  line 401"]);
  });

  test("a hashline diff numbers its rows and lines their code up with the anchored ones", () => {
    const diff = ["    ...", " 12#VR:keep", "-13    gone", "+13#VR:added", " 14#BX:more"].join("\n");
    // A gap before the first row separates nothing, so it stays a row no longer.
    expect(editBody(diff)).toEqual(["    12   keep", "    13  -gone", "    13  +added", "    14   more"]);
  });

  test("a hashline diff that only adds rows still reads as a diff", () => {
    expect(editBody([" 12#VR:keep", "+13#VR:added"].join("\n"))).toEqual(["    12   keep", "    13  +added"]);
  });
});

describe("ask rows", () => {
  const questions = [
    {
      question: "What should I start with?",
      header: "Next action",
      options: [
        { label: "Renumber, rebase, push both PRs", description: "Clear the collision; nothing moves in src/." },
        { label: "Renumber and push #1148 only" },
        { label: "Start migration step 2" },
      ],
    },
  ];
  const ask = (extra: Partial<ToolRowInput> = {}) =>
    renderToolRow(api, {
      name: "ask_user_question",
      status: "success",
      level: 0,
      args: { questions },
      ...extra,
    });
  const body = (extra: Partial<ToolRowInput> = {}, width = 80) =>
    ask(extra)
      .render(width)
      .slice(1)
      .map((row) => row.trimEnd());

  test("the header names the question by its header, or counts several", () => {
    expect(describeCall("ask_user_question", { questions })).toMatchObject({ title: "Next action" });
    expect(describeCall("ask_user_question", { questions: [{ question: "Pick one" }] })).toMatchObject({
      title: "Pick one",
    });
    expect(describeCall("ask_user_question", { questions: [questions[0]!, questions[0]!] })).toMatchObject({
      title: "2 questions",
    });
    expect(toolMeta("ask_user_question")).toMatchObject({ cls: "ask", label: "ask" });
    expect(groupVerb("ask", 2)).toBe("asked 2 questions");
  });

  test("an answered ask shows the answer it came back with, checked", () => {
    expect(body({ answers: [{ questionIndex: 0, answer: "Renumber, rebase, push both PRs" }] })).toEqual([
      "    ✓ Renumber, rebase, push both PRs",
    ]);
  });

  test("an unanswered ask lists the options it offered, without a mark", () => {
    expect(body({ status: "pending", output: "" })).toEqual([
      "      Renumber, rebase, push both PRs",
      "      Renumber and push #1148 only",
      "      Start migration step 2",
    ]);
  });

  test("opened, every option is listed with its trade-off under it", () => {
    const rows = body({
      expanded: true,
      full: true,
      answers: [{ questionIndex: 0, answer: "Start migration step 2" }],
    });
    // Opening adds the question in full and the trade-off each option was weighed against.
    expect(rows).toEqual([
      "    What should I start with?",
      "      Renumber, rebase, push both PRs",
      "      Clear the collision; nothing moves in src/.",
      "      Renumber and push #1148 only",
      "    ✓ Start migration step 2",
    ]);
  });

  test("a click opens an ask however short: its options are not its preview", () => {
    const answered = { name: "ask_user_question", status: "success" as const, level: 0 as const };
    const answers = [{ questionIndex: 0, answer: "Start migration step 2" }];
    expect(askOpensUp({ ...answered, args: { questions }, answers })).toBe(true);
    expect(askOpensUp({ ...answered, status: "pending", args: { questions } })).toBe(true);
    expect(askOpensUp({ ...answered, args: { questions }, cancelled: true })).toBe(false);
    expect(askOpensUp({ ...answered, args: {} })).toBe(false);
  });

  test("several questions name themselves in the body", () => {
    expect(
      body({
        args: {
          questions: [
            questions[0]!,
            { question: "How should it land?", header: "Delivery", options: [{ label: "One commit per module" }] },
          ],
        },
        answers: [
          { questionIndex: 0, answer: "Renumber, rebase, push both PRs" },
          { questionIndex: 1, answer: "One commit per module" },
        ],
      }),
    ).toEqual(["    ✓ Next action: Renumber, rebase, push both PRs", "    ✓ Delivery: One commit per module"]);
  });

  test("a typed answer keeps a row under the options it did not name", () => {
    expect(body({ answers: [{ questionIndex: 0, answer: "Neither: split the PR" }] })).toEqual([
      "    ✓ Neither: split the PR",
    ]);
  });

  test("a dismissed prompt says so, and nothing else", () => {
    expect(body({ cancelled: true, answers: [] })).toEqual(["    cancelled"]);
  });
});

describe("subagent rows", () => {
  const TASK = "Read the three layout files and say which one owns the panel's column widths.";
  const base = {
    name: "subagent",
    args: { agent: "scout", task: TASK },
    status: "success" as const,
    level: 0 as const,
  };
  const body = (extra: Partial<ToolRowInput> = {}, width = 80) =>
    renderToolRow(api, { ...base, ...extra })
      .render(width)
      .slice(1)
      .map((row) => row.trimEnd());

  test("the header names the child the call ran", () => {
    expect(describeCall("subagent", { agent: "scout", task: TASK })).toMatchObject({ title: "scout" });
    expect(describeCall("subagent", { agent: "scout", action: "status" })).toMatchObject({ title: "status scout" });
    expect(describeCall("subagent", { workflow: true })).toMatchObject({ title: "workflow (reply block)" });
    expect(toolMeta("subagent")).toMatchObject({ cls: "subagent", label: "subagent" });
    expect(groupVerb("subagent", 2)).toBe("ran 2 subagents");
  });

  test("before the call returns, the brief is what the row shows", () => {
    const rows = body({ status: "pending" }, 200);
    expect(rows).toEqual([`    ${TASK}`]);
  });

  test("its last message is the body, with what the child spent under it", () => {
    const rows = body({
      output: "The panel's widths live in columns.ts, not layout.ts.",
      subagent: { outputTokens: 41, inputTokens: 4400, toolCount: 3, turns: 2, durationMs: 24_000 },
    });
    expect(rows).toEqual(["    The panel's widths live in columns.ts, not layout.ts.", "    3 tools · 2 turns"]);
  });

  test("a run that came back without its child says so, with the run's id", () => {
    const rows = body(
      {
        output: "",
        subagent: { asyncId: "49de7dd6-380e-4b11-98c5-b2c1cdd37a8c" },
      },
      200,
    );
    expect(rows).toEqual([`    ${TASK}`, "    detached · run 49de7dd6"]);
  });

  test("an acceptance check that did not pass says so, under what the child spent", () => {
    const rows = body({
      output: "Done.",
      subagent: { outputTokens: 28, inputTokens: 4367, toolCount: 0, turns: 1, rejected: true },
    });
    expect(rows).toEqual(["    Done.", "    1 turn", "    acceptance rejected"]);
  });

  test("what a child spent overrides the call's own token counts in the header", () => {
    const header = toolHeader(api, { ...base, subagent: { inputTokens: 4400, outputTokens: 41 } }, 80);
    expect(header.line).toContain("↑4.4k");
    expect(header.line).toContain("↓41");
  });
});

describe("files a shell command changed", () => {
  const changes: FileChanges = {
    files: [
      {
        path: "tmp/one.txt",
        kind: "modified",
        patch: "--- tmp/one.txt\n+++ tmp/one.txt\n@@ -1,2 +1,2 @@\n-Edits: 4\n+Edits: 5\n keep\n",
      },
      { path: "tmp/two.txt", kind: "created", patch: "--- tmp/two.txt\n+++ tmp/two.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n" },
    ],
  };
  const bash = (extra: Partial<ToolRowInput> = {}) =>
    toolRowLayout(
      api,
      {
        name: "bash",
        status: "success",
        level: 0,
        args: { command: "printf 'Edits: 5' > tmp/one.txt" },
        output: "(no output)",
        changes,
        ...extra,
      },
      80,
    );
  const body = (extra: Partial<ToolRowInput> = {}) =>
    bash(extra)
      .rows.slice(1)
      .map((row) => row.trimEnd());

  test("each changed file follows the output: a path row, then its diff numbered like an edit's", () => {
    expect(body()).toEqual([
      "    (no output)",
      "    M tmp/one.txt  +1 -1",
      "    1  -Edits: 4",
      "    1  +Edits: 5",
      "    2   keep",
      "    A tmp/two.txt  +2",
      "    1  +a",
      "    2  +b",
    ]);
  });

  test("the changed lines take the edit's backgrounds", () => {
    const tokens = {
      ...api,
      theme: {
        ...theme,
        style: (text: string, options: { bg?: string }) => (options.bg ? `<${options.bg}>${text}` : text),
      },
    };
    const rows = toolRowLayout(
      tokens,
      { name: "bash", status: "success", level: 0, output: "(no output)", changes },
      80,
    ).rows.map((row) => row.trim());
    expect(rows.filter((row) => row.startsWith("<toolErrorBg>"))).toHaveLength(1);
    expect(rows.filter((row) => row.startsWith("<toolSuccessBg>"))).toHaveLength(3);
  });

  test("the file rows count in the row budget, so an older block keeps fewer", () => {
    const heights = ([0, 2, 4] as const).map((level) => bash({ level }).rows.length - 1);
    expect(heights).toEqual([8, 6, 4]);
    // The output keeps its row; the files keep what they can of their evidence and count the rest.
    expect(body({ level: 4 })).toEqual([
      "    (no output)",
      "    M tmp/one.txt  +1 -1",
      "    1  -Edits: 4",
      "    ↓  4 more lines",
    ]);
    expect(bash({ level: 4 }).omission).toBe(4);
    // Hidden file rows make the block openable, and opening it shows them all.
    expect(previewLineCount({ name: "bash", status: "success", level: 4, output: "(no output)", changes })).toBe(8);
    expect(body({ level: 4, expanded: true, full: true })).toHaveLength(8);
  });

  test("a long log keeps its newest lines above the files, which take the larger half", () => {
    const rows = body({ level: 1, output: OUTPUT });
    expect(rows).toHaveLength(7);
    expect(rows.slice(0, 3)).toEqual(["    ↑  38 more lines", "    line 39", "    line 40"]);
    expect(rows[3]).toBe("    M tmp/one.txt  +1 -1");
  });

  test("the files' syntax colours stay within the work bound a read's have", () => {
    const highlighted: number[] = [];
    const counting = {
      ...api,
      kit: {
        ...kit,
        languageFromPath: () => "ts",
        highlight: (source: string) => {
          highlighted.push(source.length);
          return source.split("\n");
        },
      },
    };
    const big = `@@ -0,0 +1,3000 @@\n${Array.from({ length: 3000 }, (_, i) => `+const value${i} = ${i};`).join("\n")}\n`;
    const small = "@@ -1 +1 @@\n-a\n+b\n";
    toolRowLayout(
      counting,
      {
        name: "bash",
        status: "success",
        level: 0,
        output: "(no output)",
        changes: {
          files: [
            { path: "big.ts", kind: "created", patch: big },
            { path: "small.ts", kind: "modified", patch: small },
          ],
        },
      },
      80,
    );
    // The oversized patch takes no colours; the small one still does.
    expect(highlighted.every((length) => length < 100)).toBe(true);
    expect(highlighted.length).toBeGreaterThan(0);
  });

  test("a deleted file is its row; a binary and an oversized file say so instead of a diff", () => {
    const rows = body({
      expanded: true,
      full: true,
      changes: {
        files: [
          { path: "gone.txt", kind: "deleted" },
          { path: "logo.png", kind: "modified", note: "binary" },
          { path: "dump.sql", kind: "created", note: "too large" },
          { path: "empty.txt", kind: "created", patch: "" },
        ],
        more: 3,
      },
    });
    expect(rows).toEqual([
      "    (no output)",
      "    D gone.txt",
      "    M logo.png",
      "    binary file changed",
      "    A dump.sql",
      "    new file, too large to diff",
      "    A empty.txt",
      "    new empty file",
      "    3 more files changed",
    ]);
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
    expect(label).toMatch(/^✻ think · done {2,}↓17 · 3.2s turn$/);
  });

  test("live label stays within the pool of rows", () => {
    const label = thinkingLabel(api, { phase: "thinking", level: 0, text: OUTPUT, width: 80, frame: 3 });
    expect(label.split("\n").length).toBeLessThanOrEqual(8);
  });

  test("a one-row thought that fits whole shows all of it and cannot open", () => {
    const layout = thinkingLayout(api, { phase: "aged", level: 7, text: "first\nlast", width: 80 });
    expect(layout.label).toMatch(/^✻ think · first last {2,}↓\d+$/);
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
      expect(layout.label).toMatch(/^✻ think · Scoping latest commit review {2,}↓\d+ · 5.2s$/);
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
      expect(layout.label).toMatch(/^✻ think · line 1 .* … .*line 40 · +↓\d+/);
      expect(layout.label.length).toBe(width - 1);
      expect(layout.canToggle).toBe(true);
    }
    const narrow = thinkingLayout(api, { phase: "aged", level: 7, text: OUTPUT, width: 41, durationMs: 12400 });
    expect(narrow.label).toMatch(/^✻ think · li.* … .*0 · ↓78/);
    expect(narrow.label.length).toBe(40);
  });

  test("aged level 7 is exactly one line and keeps the last thought", () => {
    const label = thinkingLabel(api, { phase: "aged", level: 7, text: OUTPUT, width: 80, durationMs: 12400 });
    expect(label.split("\n")).toHaveLength(1);
    expect(label).toContain("line 40");
    expect(label).toContain("↓78 @ 6.3/s · 12s");
  });

  test("expanded label shows more rows than collapsed", () => {
    const collapsed = thinkingLabel(api, { phase: "aged", level: 1, text: OUTPUT, width: 80 });
    const expanded = thinkingLabel(api, { phase: "aged", level: 1, text: OUTPUT, width: 80, expanded: true });
    expect(expanded.split("\n").length).toBeGreaterThan(collapsed.split("\n").length);
  });

  test("a streaming paragraph wraps and shows its newest words at the bottom", () => {
    const long = `first ${Array.from({ length: 60 }, (_, index) => `w${index}`).join(" ")} newest`;
    const label = thinkingLabel(api, { phase: "thinking", level: 0, text: long, width: 40 });
    const lines = label.split("\n");
    // One paragraph, many rows: the tail keeps its newest rows, with the notice above them.
    expect(label).not.toContain("…");
    expect(lines[1]).toMatch(/↑ \d+ more lines?/);
    expect(lines.at(-1)!.trimEnd()).toEndWith("newest");
    expect(label).not.toContain("first");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    // Tokens arriving at the end change only the bottom row (and the header's token count).
    const more = thinkingLabel(api, { phase: "thinking", level: 0, text: `${long} more`, width: 40 }).split("\n");
    expect(more.slice(1, -1)).toEqual(lines.slice(1, -1));
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

const many = (n: number) => Array.from({ length: n }, (_, index) => `↓${index + 1}`).join("\n");

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
  // The command ends where the metrics' gap (or, when they meet, their separator) begins.
  const headOf = (header: string) =>
    header
      .slice(column)
      .split(/ · | {2,}/)[0]!
      .trimEnd();

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
    expect(toolHeader(api, input, 80).hiddenTitle).toBe(command);
    expect(toolHeader(api, { ...input, expanded: true, full: true }, 80).hiddenTitle).toBe(command);
  });
});

describe("opened titles", () => {
  const path = "packages/pi-ui/extensions/some/deeply/nested/folder/thinking.ts";
  const read = (extra: Partial<ToolRowInput> = {}) =>
    renderToolRow(api, {
      name: "read",
      status: "success",
      level: 0,
      args: { path },
      output: "one\ntwo",
      durationMs: 10,
      ...extra,
    }).render(50);
  /** The column a read's title starts in: after `● read · `. */
  const titleColumn = "● read · ".length;

  test("a closed block keeps a long path's left cut", () => {
    expect(read()[0]).toContain(" … ");
    expect(read()[0]).toContain("thinking.ts");
  });

  test("an opened block shows the whole path, breaking after a `/`, aligned under its start", () => {
    const rows = read({ expanded: true, full: true });
    expect(rows[0]).not.toContain("…");
    const header = rows[0]!.slice(titleColumn).split(/ · | {2,}/)[0]!;
    expect(header.endsWith("/")).toBe(true);
    const continued = rows.slice(1).filter((line) => !/^\s+\d+ {2}/.test(line));
    expect(continued.every((line) => line.startsWith(" ".repeat(titleColumn)) && line[titleColumn] !== " ")).toBe(true);
    expect(continued.slice(0, -1).every((line) => line.trimEnd().endsWith("/"))).toBe(true);
    expect(header + continued.map((line) => line.trim()).join("")).toBe(path);
    // The file's lines follow the path.
    expect(rows.slice(-2).map((line) => line.trim())).toEqual(["1  one", "2  two"]);
    expect(rows.every((line) => line.length <= 50)).toBe(true);
  });

  test("an opened grep shows its whole pattern", () => {
    const pattern = "toolRowLayout\\(|renderToolRow\\(|previewLineCount\\(|selectDiff\\(";
    const rows = renderToolRow(api, {
      name: "grep",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      args: { pattern },
      output: "a.ts:1:x",
    }).render(40);
    const column = "● grep · ".length;
    const titleRows = [rows[0]!.slice(column).split(" · ")[0]!, ...rows.slice(1, -1).map((line) => line.trim())];
    expect(titleRows.join("")).toBe(pattern);
  });

  test("an opened title takes at most half the budget when there is output to show", () => {
    const long = Array.from({ length: 3000 }, (_, index) => `dir${index}`).join("/");
    const rows = renderToolRow(api, {
      name: "read",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      args: { path: long },
      output: many(1000),
    }).render(60);
    expect(rows.length).toBeLessThanOrEqual(1 + MAX_FULL_LINES);
    const notice = rows.findIndex((line) => line.trim().endsWith("more lines"));
    expect(notice).toBe(Math.ceil(MAX_FULL_LINES / 2));
    expect(rows.join("\n")).toContain("↓1");
  });

  test("a lit opened title lights every line it takes", () => {
    const tokens = {
      ...api,
      theme: { ...theme, fg: (token: string, text: string) => (token === "text" ? text.toUpperCase() : text) },
    };
    const rows = renderToolRow(tokens, {
      name: "read",
      status: "success",
      level: 0,
      expanded: true,
      full: true,
      lit: true,
      args: { path },
      output: "one",
    }).render(50);
    expect(rows.slice(1, -1).every((line) => line.trim() === line.trim().toUpperCase())).toBe(true);
    expect(rows[0]).toContain("PACKAGES/");
  });
});

describe("full body budget", () => {
  test("an expanded command and its output share one line cap", () => {
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
      expect(rows.join("\n")).toContain(output === "done" ? "done" : `↓${output.split("\n").length}`);
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
    expect(rows.join("\n")).toContain("↓900");
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
  expect(line?.trim()).toMatch(/^<i><dim>[↑↓⋮] \d+ more lines?<\/dim><\/i>$/);

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
      diff: ["↓ 26 more lines"],
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
    const small = ["@@ -1,5 +1,5 @@", " one", "-old", "+new", " two", " three", " four"].join("\n");
    const rows = renderToolRow(api, { name: "edit", status: "success", level: 3, output: small }).render(80);
    expect(rows.at(-1)?.trim()).toBe("⋮  4 more lines");
  });

  test("a lit notice turns the text colour on every block kind", () => {
    const tokens = { ...api, theme: { ...theme, fg: (token: string, text: string) => `<${token}>${text}</${token}>` } };
    const tail = renderToolRow(tokens, { name: "bash", status: "success", level: 4, output: OUTPUT, lit: true }).render(
      80,
    );
    expect(tail.find((line) => line.includes("more lines"))).toContain("<text>");
    const thought = thinkingLabel(tokens, {
      phase: "aged",
      level: 3,
      text: Array.from({ length: 10 }, (_, index) => `thought ${index + 1}`).join("\n"),
      width: 80,
      lit: true,
    });
    expect(thought.split("\n").find((line) => line.includes("more lines"))).toContain("<text>");
  });

  test("a lit header turns its title the text colour, cut or whole, and keeps the cut mark", () => {
    // The `text` colour shows as upper case, so the widths stay true; the cut mark is styled apart.
    const tokens = {
      ...api,
      theme: { ...theme, fg: (token: string, text: string) => (token === "text" ? text.toUpperCase() : text) },
    };
    const printf = `printf 'Edits: 5\\n' > ./tmp/one.txt; for file in a b c; do echo "$file"; done`;
    const bash = (lit: boolean, width = 60) =>
      toolHeader(tokens, { name: "bash", status: "success", level: 0, args: { command: printf }, lit }, width).line;
    // The command's two kept ends turn the text colour; the cut mark stays as it is.
    expect(bash(true)).toMatch(/PRINTF[^a-z]* … [^a-z]*DONE/);
    expect(bash(false)).toMatch(/printf.* … .*done/);
    // A title shown whole lights too: the pointer's feedback does not wait for a cut.
    expect(bash(true, 200)).toContain(printf.toUpperCase());
    expect(bash(false, 200)).toContain(printf);
    // A short title takes the light as well: a todo's `add` would otherwise never change.
    const add = (lit: boolean) =>
      toolHeader(tokens, { name: "todo", status: "success", level: 0, args: { action: "add" }, lit }, 60).line;
    expect(add(true)).toMatch(/ADD/);
    expect(add(false)).toMatch(/add/);
    // A path cut on the left lights its kept end.
    const path = "packages/pi-ui/extensions/some/deeply/nested/folder/file.ts";
    const read = toolHeader(tokens, { name: "read", status: "success", level: 0, args: { path }, lit: true }, 50).line;
    expect(read).toMatch(/ … [^a-z]*FILE\.TS/);
    // A thought's excerpt cut in the middle lights both its ends; one that fits does not change.
    const thought = (text: string) =>
      thinkingLabel(tokens, { phase: "aged", level: 7, text, width: 60, lit: true }).split("\n")[0] ?? "";
    expect(thought("one two three four five six seven eight nine ten eleven twelve thirteen")).toMatch(
      /ONE[^a-z]* … [^a-z]*THIRTEEN/,
    );
    expect(thought("short thought")).toContain("short thought");
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
  test("a tail of a long log fills the hidden lines above it", () => {
    const layout = toolRowLayout(api, { name: "bash", status: "success", level: 0, output: many(160) }, 80);
    expect(layout.bar).toEqual(["fill", "fill", "fill", "fill", "fill", "fill", "fill", "track"]);
    expect(layout.bar).toHaveLength(layout.rows.length - 1);
    // The notice heads the tail beside filled cells; the newest lines sit beside a track cell.
    expect(layout.rows[1]).toMatch(/↑ 153 more lines$/);
    expect(layout.sources?.[0]).toBeUndefined();
  });

  test("a read cut in the middle fills the middle", () => {
    const layout = toolRowLayout(api, { name: "read", status: "success", level: 4, output: OUTPUT }, 80);
    expect(layout.bar).toEqual(["track", "fill", "fill", "track"]);
  });

  test("a preview that shows everything fills nothing, and an open row has no preview bar", () => {
    expect(toolRowLayout(api, { name: "bash", status: "success", level: 0, output: many(3) }, 80).bar).toEqual([
      "track",
      "track",
      "track",
    ]);
    expect(
      toolRowLayout(
        api,
        { name: "bash", status: "success", level: 0, output: many(160), expanded: true, full: true },
        80,
      ).bar,
    ).toBeUndefined();
  });

  test("a settled thought's bar covers its body rows, notice included, and fills what its tail hides", () => {
    const text = Array.from({ length: 10 }, (_, index) => `thought ${index + 1}`).join("\n");
    const layout = thinkingLayout(api, { phase: "aged", level: 3, text, width: 80 });
    const rows = layout.label.split("\n");
    // The notice above three kept lines: ten sources over four cells, the last three shown,
    // so the cells above the newest row are filled and the newest row's cell is track.
    expect(rows[1]).toContain("↑ 7 more lines");
    expect(rows.at(-1)).toContain("thought 10");
    expect(layout.bar).toEqual(["fill", "fill", "fill", "track"]);
    expect(layout.bar).toHaveLength(rows.length - 1);
  });

  test("a streaming thought's notice row sits at the top of its bar like any other row", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const layout = thinkingLayout(api, { phase: "thinking", level: 0, text, width: 40 });
    const rows = layout.label.split("\n");
    expect(rows[1]?.trim()).toBe("↑ 94 more lines");
    expect(layout.bar).toEqual(["fill", "fill", "fill", "fill", "fill", "fill", "track"]);
    expect(layout.bar).toHaveLength(rows.length - 1);
  });

  test("a formatted thought maps its formatted rows", () => {
    const markdown = { ...api, kit: { ...kit, markdown: (text: string, width: number) => wrapPlain(text, width) } };
    const text = Array.from({ length: 12 }, (_, index) => `- item ${index + 1}`).join("\n");
    const layout = thinkingLayout(markdown, { phase: "aged", level: 3, text, width: 80 });
    expect(layout.label).toContain("↑ 9 more lines");
    expect(layout.bar).toEqual(["fill", "fill", "fill", "track"]);
  });

  test("a thought shown whole fills nothing; inline and open thoughts have no preview bar", () => {
    const short = "one\ntwo";
    expect(thinkingLayout(api, { phase: "aged", level: 0, text: short, width: 80 }).bar).toEqual(["track", "track"]);
    expect(thinkingLayout(api, { phase: "aged", level: 7, text: OUTPUT, width: 80 }).bar).toBeUndefined();
    expect(
      thinkingLayout(api, { phase: "aged", level: 1, text: OUTPUT, width: 80, expanded: true }).bar,
    ).toBeUndefined();
  });

  test("each cell stands for an equal share of the lines and fills when none of them show", () => {
    expect(previewBar(10, new Set([4, 5]), 5)).toEqual(["fill", "fill", "track", "fill", "fill"]);
    expect(previewBar(3, new Set([2]), 6)).toEqual(["fill", "fill", "fill", "fill", "track", "track"]);
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
      41,
    );
    expect(head).toContain("assistant-message.js");
    expect(head.endsWith("0.…")).toBe(false);
    // One column short of the edge, where pi draws its scroll bar.
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

  test("an output rate needs enough tokens to mean something", () => {
    expect(toolTokenLabel(5, 40, { outputRate: 985 })).toBe("↑40 · ↓5");
    expect(toolTokenLabel(MIN_RATE_TOKENS, 40, { outputRate: 60 })).toBe(`↑40 · ↓${MIN_RATE_TOKENS} @ 60/s`);
    const burst = thinkingLabel(api, {
      phase: "aged",
      level: 7,
      text: "I need composeFrame.",
      width: 80,
      durationMs: 5,
    });
    expect(burst).not.toContain("/s");
  });

  test("an estimated prefill rate is marked as approximate", () => {
    expect(toolTokenLabel(26, 5500, { outputRate: 73, inputRate: 2500 })).toBe("↑5.5k @ 2.5k/s · ↓26 @ 73/s");
    expect(toolTokenLabel(26, 5500, { outputRate: 73, inputRate: 2500, inputRateEstimated: true })).toBe(
      "↑5.5k @ ~2.5k/s · ↓26 @ 73/s",
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
    const tools = Array.from({ length: FOLD_DISTANCE + 1 }, () => tool);
    const mixed = blockDistances([{ kind: "thinking", withProse: true }, ...tools]);
    expect(mixed.map((block) => block.distance)).toEqual([
      FOLD_DISTANCE,
      ...tools.map((_, index) => FOLD_DISTANCE - index),
    ]);
  });

  test("distances stop at the fold distance", () => {
    const distances = blockDistances(Array.from({ length: FOLD_DISTANCE + 7 }, () => tool));
    const recent = Array.from({ length: FOLD_DISTANCE }, (_, index) => FOLD_DISTANCE - 1 - index);
    expect(distances.map((block) => block.distance)).toEqual([
      ...Array.from({ length: 7 }, () => FOLD_DISTANCE),
      ...recent,
    ]);
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
        expect(line).not.toContain("↑48k");
        expect(line).not.toContain("1m 33s");
      }
      if (line.includes("↑48k") || line.includes("1m 33s")) expect(perSegment).toBe(true);
      if (line.includes("↑48k") && !line.includes("1m 33s")) {
        expect(renderGroupRow(api, { ...input, tokens: undefined }).render(width)[0]).toContain("1m 33s");
      }
    }
  });

  test("a wide summary keeps every segment, its failures and the metrics", () => {
    const line = renderGroupRow(api, input).render(120)[0]!;
    expect(line).toMatch(
      /^▸ Read 4 files, ran 24 shell commands \(4 failed\), edited 2 files \(1 failed\) {2,}↑48k · ↓1.2k/,
    );
    expect(line).toEndWith("1m 33s");
  });

  test("metrics go before any segment is cut, duration first", () => {
    const title = "▸ Read 4 files, ran 24 shell commands (4 failed), edited 2 files (1 failed)";
    const tokens = renderGroupRow(api, { ...input, durationMs: undefined }).render(120)[0]!;
    // The metrics as the row's end shows them, with the separator they need when they meet the title.
    const tokensOnly = ` · ${tokens.trimEnd().split(/ {2,}/).at(-1)}`;
    const line = renderGroupRow(api, input).render(title.length + tokensOnly.length + HEADER_MARGIN)[0]!;
    expect(line).toStartWith(title);
    expect(line).toContain("↑48k");
    expect(line).not.toContain("1m 33s");
    expect(renderGroupRow(api, input).render(title.length + " · 1m 33s".length + HEADER_MARGIN)[0]).toBe(
      `${title} · 1m 33s`,
    );
    expect(renderGroupRow(api, input).render(title.length + HEADER_MARGIN)[0]).toBe(title);
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
    }).render(17)[0];
    expect(line).toBe("▸ Read 4 file … ");
  });

  test("a cut summary keeps whole segments, never half a duration", () => {
    const summary = {
      segments: [
        { cls: "read" as const, count: 1 },
        { cls: "search" as const, count: 1 },
        { cls: "shell" as const, count: 1, durationMs: 900 },
      ],
    };
    const full = renderGroupRow(api, summary).render(200)[0]!;
    expect(full).toBe("▸ Read 1 file, searched for 1 pattern, ran 1 shell command for 900ms");
    // Too narrow for the whole sentence: the last segment leaves entirely.
    expect(renderGroupRow(api, summary).render(full.length - 1)[0]).toBe("▸ Read 1 file, searched for 1 pattern … ");
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
  test("a streaming paragraph that fits once wrapped hides nothing", () => {
    const input = { phase: "thinking" as const, level: 0 as const, text: "hello world ".repeat(5), width: 40 };
    const label = thinkingLabel(api, input);
    expect(label).not.toContain("…");
    expect(label).not.toContain("more lines");
    expect(thinkingLayout(api, input).canToggle).toBe(false);
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
      "                 ↓15 @ 3.6/s ·  4.2s",
      "↑1.2k @ ~840/s ·  ↓9         · 900ms",
    ]);
  });

  test("a group with no input leaves out the input columns", () => {
    const cells = [{ label: "think", outValue: "15", duration: "4.2s" }];
    expect(
      metricColumns(
        cells[0]!,
        memberColumns(cells, (text) => text.length),
      ),
    ).toBe("↓15 · 4.2s");
  });
});

describe("session place", () => {
  const place = { cwd: "/home/dev/pi-ui", home: "/home/dev" };

  test("a path inside the working directory reads relative to it; others stay as written", () => {
    expect(sessionPath("/home/dev/pi-ui/docs/PLAN.md", place)).toBe("docs/PLAN.md");
    expect(sessionPath("~/pi-ui/docs/PLAN.md", place)).toBe("docs/PLAN.md");
    expect(sessionPath("/home/dev/pi-ui", place)).toBe(".");
    expect(sessionPath("/home/dev/pi-ui-old/a.ts", place)).toBe("/home/dev/pi-ui-old/a.ts");
    expect(sessionPath("/tmp/review.md", place)).toBe("/tmp/review.md");
    expect(sessionPath("~/other/a.ts", place)).toBe("~/other/a.ts");
    expect(sessionPath("/home/dev/pi-ui/a.ts")).toBe("/home/dev/pi-ui/a.ts");
  });

  test("a command drops a leading cd into the working directory, and only that", () => {
    expect(sessionCommand("cd ~/pi-ui && git status --short", place)).toBe("git status --short");
    expect(sessionCommand("cd /home/dev/pi-ui; ls", place)).toBe("ls");
    expect(sessionCommand('cd "/home/dev/pi-ui" && ls', place)).toBe("ls");
    expect(sessionCommand("cd /tmp && ls", place)).toBe("cd /tmp && ls");
    expect(sessionCommand("cd ~/pi-ui/docs && ls", place)).toBe("cd ~/pi-ui/docs && ls");
    expect(sessionCommand("cd ~/pi-ui || exit 1", place)).toBe("cd ~/pi-ui || exit 1");
    expect(sessionCommand("cd ~/pi-ui", place)).toBe("cd ~/pi-ui");
  });

  test("headers and opened commands read from the working directory", () => {
    const bash = toolHeader(
      api,
      { name: "bash", status: "success", level: 0, args: { command: "cd ~/pi-ui && ls" }, ...place },
      80,
    );
    expect(bash.line).toStartWith("● bash · ls ");
    expect(bash.hiddenTitle).toBeUndefined();
    const read = toolHeader(
      api,
      { name: "read", status: "success", level: 0, args: { path: "/home/dev/pi-ui/DESIGN.md" }, ...place },
      80,
    );
    expect(read.line).toStartWith("● read · DESIGN.md ");
  });
});

/** A header's title: the text between the label's separator and the metrics (a cut can leave two spaces). */
const headerTitle = (line: string) => line.split(/ {3,}| · /)[1] ?? "";

describe("narrow headers", () => {
  const command = "head -30 /tmp/ds-inline.js /tmp/ds-inline2.js /tmp/headline-report.md 2>/dev/null";
  const input = {
    name: "bash",
    status: "success",
    level: 0,
    args: { command },
    outputTokens: 44,
    inputTokens: 1700,
    outputRate: 81,
    inputRate: 2400,
    durationMs: 32,
  } as const;

  test("metrics shrink before the command does: rates go, then the input count, then all of them", () => {
    const wide = toolHeader(api, input, 140).line;
    expect(wide).toContain("↑1.7k @ 2.4k/s · ↓44 @ 81/s");
    const rows = [100, 80, 70, 50].map((width) => toolHeader(api, input, width).line);
    expect(rows.every((line, index) => line.length <= [100, 80, 70, 50][index]! - 1)).toBe(true);
    // At every width the command keeps at least 40% of the row, or 20 columns.
    for (const [index, width] of [100, 80, 70, 50].entries())
      expect(headerTitle(rows[index]!).length).toBeGreaterThanOrEqual(
        Math.min(command.length, Math.max(20, Math.floor((width - 1) * 0.4))) - 1,
      );
    expect(rows.some((line) => line.includes("↑1.7k · ↓44") && !line.includes("/s"))).toBe(true);
  });
});

describe("blank lines", () => {
  const output = "line one\n\nline three\n\n\nline six";
  const read = (full: boolean) =>
    renderToolRow(api, {
      name: "read",
      status: "success",
      level: 0,
      args: { path: "a.txt" },
      output,
      expanded: full,
      full,
    })
      .render(80)
      .slice(1)
      .map((line) => line.trimEnd());

  test("a preview skips them and keeps the numbers; an opened read shows the file as it is", () => {
    expect(read(false).map((line) => line.trim())).toEqual(["1  line one", "3  line three", "6  line six"]);
    expect(read(true).map((line) => line.trim())).toEqual([
      "1  line one",
      "2",
      "3  line three",
      "4",
      "5",
      "6  line six",
    ]);
  });
});

describe("member table words", () => {
  test("each column's word sits on the first row that fills it", () => {
    const rows = [
      { label: "think", outValue: "15", duration: "4.2s" },
      { label: "read", outValue: "9", inValue: "60", duration: "380ms" },
      { label: "grep", outValue: "12", inValue: "13", duration: "60ms" },
    ];
    expect(columnLabelRows(rows)).toEqual([
      { out: true, in: false },
      { out: false, in: true },
      { out: false, in: false },
    ]);
    const columns = { label: 5, outValue: 2, outRate: 0, inValue: 2, inRate: 0, duration: 5 };
    expect(columnLabelRows(rows).map((labels, index) => metricColumns(rows[index]!, columns, labels))).toEqual([
      "      ↓15 ·  4.2s",
      "↑60     9   380ms",
      " 13    12    60ms",
    ]);
  });
});

/** A call still being written: its arguments so far, no result. */
const trimmed = (rows: string[]) => rows.slice(1).map((line) => line.trimEnd());
const pendingRow = (name: string, args: Record<string, unknown>, extra: Partial<ToolRowInput> = {}) =>
  renderToolRow(api, { name, status: "pending", level: 0, args, ...extra });

describe("a call being written", () => {
  test("an edit streams its replacements: removed lines, then added ones, a divider between edits", () => {
    const rows = pendingRow("edit", {
      path: "src/cache.ts",
      edits: [
        { oldText: "const a = 1;\nconst b = 2;", newText: "const a = 10;" },
        { oldText: "return a;", newText: "return a +" },
      ],
    }).render(80);
    // A replacement's rows are stripes that run to the row's end.
    expect(rows.slice(1).map((line) => line.trimEnd())).toEqual([
      "    -const a = 1;",
      "    -const b = 2;",
      "    +const a = 10;",
      "    ⋮",
      "    -return a;",
      "    +return a +",
    ]);
  });

  test("an edit whose new text has not started shows its old text, and a bare path shows nothing", () => {
    expect(trimmed(pendingRow("edit", { path: "a.ts", edits: [{ oldText: "old line" }] }).render(80))).toEqual([
      "    -old line",
    ]);
    expect(pendingRow("edit", { path: "a.ts" }).render(80)).toHaveLength(1);
    expect(pendingRow("edit", { path: "a.ts", edits: [{}] }).render(80)).toHaveLength(1);
  });

  test("pi's other edit shapes stream too: one object, a JSON string, the legacy fields", () => {
    const expected = ["    -x", "    +y"];
    for (const args of [
      { path: "a.ts", edits: { oldText: "x", newText: "y" } },
      { path: "a.ts", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) },
      { path: "a.ts", oldText: "x", newText: "y" },
    ])
      expect(trimmed(pendingRow("edit", args).render(80))).toEqual(expected);
  });

  test("an edit in a shape it does not know shows its arguments as fields", () => {
    const rows = pendingRow("edit", { path: "a.ts", hashline: "12:ab|const x = 1;" }).render(80);
    expect(rows.slice(1)).toEqual(["    hashline  12:ab|const x = 1;"]);
    // pi-hashline-edit's own edits: anchored line ranges, not oldText/newText.
    const anchored = pendingRow("edit", { path: "a.ts", edits: [{ pos: "12#ab", lines: ["const x = 2;"] }] });
    expect(anchored.render(80).slice(1).join("\n")).toContain('"pos": "12#ab"');
  });

  test("a long edit keeps its newest lines, with the hidden ones counted above", () => {
    const newText = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const rows = pendingRow("edit", { path: "a.ts", edits: [{ oldText: "x", newText }] }).render(80);
    expect(rows[1]).toContain("more lines");
    expect(rows.at(-1)?.trimEnd()).toBe("    +line 30");
  });

  test("other calls show every argument their title does not, one field after another", () => {
    const rows = pendingRow("read", { path: "src/a.ts", offset: 120, limit: 80 }).render(80);
    expect(rows[0]).toContain("src/a.ts");
    expect(rows.slice(1)).toEqual(["    offset  120", "    limit   80"]);
    const mcp = pendingRow("mcp__docs__search", { query: "fold", filters: { lang: "ts" } }).render(80);
    expect(mcp.slice(1)).toEqual(["    filters  {", '               "lang": "ts"', "             }"]);
  });

  test("a shell command too long for its header streams under it; an opened one does not repeat it", () => {
    const command = "python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY";
    expect(pendingRow("bash", { command }).render(80).slice(1)).toEqual([
      "    python3 - <<'PY'",
      "    import json",
      "    print(json.dumps({'a': 1}))",
      "    PY",
    ]);
    expect(pendingRow("bash", { command: "ls -la" }).render(80)).toHaveLength(1);
    const opened = pendingRow("bash", { command }, { expanded: true }).render(80);
    expect(opened.filter((line) => line.includes("import json"))).toHaveLength(1);
  });

  test("a line being written wraps instead of being cut, so its newest characters show", () => {
    const command = `grep -rn ${"pattern ".repeat(12)}packages --include '*.ts' END`;
    const rows = pendingRow("bash", { command }).render(60);
    expect(rows.at(-1)?.trimEnd()).toEndWith("END");
    expect(rows.slice(1).join("")).not.toContain("…");
    const newText = `const total = ${"value + ".repeat(12)}LAST;`;
    const edit = pendingRow("edit", { path: "a.ts", edits: [{ oldText: "x", newText }] }).render(60);
    expect(edit.at(-1)?.trimEnd()).toEndWith("LAST;");
  });

  test("a short command the header only tidies streams no body row while it is typed", () => {
    for (const command of ["git ", "ls  -la", "bun\ttest"])
      expect(pendingRow("bash", { command }).render(80)).toHaveLength(1);
  });

  test("a line taller than the rows left keeps its end, under a cut row", () => {
    const rows = pendingRow("bash", { command: `${"x".repeat(1990)}NEWEST` }).render(60);
    expect(rows[1]?.trim()).toBe("…");
    expect(rows.at(-1)?.trimEnd()).toEndWith("NEWEST");
  });

  test("a write's long line wraps while it streams, so its newest characters show", () => {
    const rows = pendingRow("write", { path: "a.ts", content: `short\n${"y".repeat(150)}NEWEST` }).render(60);
    expect(rows.at(-1)?.trimEnd()).toEndWith("NEWEST");
    expect(rows.join("\n")).not.toContain("…");
  });

  test("the first output replaces the arguments", () => {
    const rows = pendingRow("bash", { command: "a\nb" }, { status: "running", output: "hello" }).render(80);
    expect(rows.slice(1)).toEqual(["    hello"]);
    const read = pendingRow("read", { path: "a.ts", offset: 3 }, { status: "success", output: "x" }).render(80);
    expect(read.join("\n")).not.toContain("offset");
  });
});

describe("image rows by detail level", () => {
  test("an image is whole while newest or open, shrinks with the body's budget, and is gone while folded", () => {
    expect(imageRowsFor(27, 0, false, false)).toBe(27);
    // Level 5 keeps 3 of the newest block's 8 body lines: 3/8 of the image's height.
    expect(imageRowsFor(27, 5, false, false)).toBe(10);
    expect(imageRowsFor(27, 7, false, false)).toBe(MIN_IMAGE_ROWS);
    expect(imageRowsFor(27, 7, true, false)).toBe(27);
    expect(imageRowsFor(27, 3, false, true)).toBe(0);
    expect(imageRowsFor(27, 3, true, true)).toBe(27);
    // A short image (a text fallback, a wide banner) never grows to the thumbnail floor.
    expect(imageRowsFor(1, 7, false, false)).toBe(1);
  });

  test("every older level keeps the image at least as small as the one before", () => {
    const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((level) => imageRowsFor(27, level as 0, false, false));
    expect(rows.every((value, index) => index === 0 || value <= rows[index - 1]!)).toBe(true);
  });
});

/** A todo as the panel's tests build them. */
const todo = (id: number, status: TodoItem["status"], text = `todo ${id}`, activeForm?: string): TodoItem => ({
  id,
  text,
  status,
  ...(activeForm ? { activeForm } : {}),
});
const todoLines = (todos: TodoItem[], width = 80, frame = 0) => todosLines(api, { todos, frame }, width);
const manyTodos = (count: number, status: TodoItem["status"] = "pending") =>
  Array.from({ length: count }, (_, index) => todo(index + 1, status));

describe("todos panel", () => {
  test("the heading counts the work and draws its share, and a row per todo keeps the ids", () => {
    const rows = todoLines([todo(1, "completed"), todo(2, "in_progress"), todo(3, "pending"), todo(4, "pending")]);
    expect(rows[0]).toBe("● Todos 1/4  ▰▱▱▱");
    expect(rows[1]).toBe("  ✓ #1 todo 1");
    // The spinner frame is an input: fixtures pin one, pi's repaints move it.
    expect(rows[2]).toBe("  ⠋ #2 todo 2");
    expect(todoLines([todo(2, "in_progress")], 80, 3)[0]).toBe("● Todos 0/1  ▱");
    expect(todoLines([todo(2, "in_progress")], 80, 3)[1]).toBe("  ⠸ #2 todo 2");
  });

  test("the active form shows beside the todo only when it says more", () => {
    expect(todoLines([todo(2, "in_progress", "Write the renderer", "Writing the renderer")])[1]).toBe(
      "  ⠋ #2 Write the renderer (Writing the renderer)",
    );
    expect(todoLines([todo(2, "in_progress", "Write the renderer", "Write the renderer")])[1]).toBe(
      "  ⠋ #2 Write the renderer",
    );
  });

  test("a finished list keeps one line", () => {
    expect(todoLines([todo(1, "completed"), todo(2, "completed")])).toEqual(["○ Todos 2/2 · done"]);
  });

  test("the bar fills a cell per todo, and no more than eight cells", () => {
    expect([todoBar(0, 4), todoBar(1, 4), todoBar(2, 4), todoBar(4, 4)]).toEqual([
      { filled: 0, cells: 4 },
      { filled: 1, cells: 4 },
      { filled: 2, cells: 4 },
      { filled: 4, cells: 4 },
    ]);
    expect(todoBar(10, 20)).toEqual({ filled: 4, cells: 8 });
  });

  test("a list over the budget keeps the work's rows and counts the rest inside the budget", () => {
    const pending = todoLines(manyTodos(15));
    expect(pending).toHaveLength(TODOS_PANEL_LINES);
    expect(pending.at(-1)).toBe("⋮ 7 more · 7 pending");
    expect(pending.slice(1, -1)).toHaveLength(8);

    // Finished work leaves first: the heading already counts it.
    const mixed = todoLines([
      todo(1, "completed", "finished one"),
      todo(2, "completed", "finished two"),
      ...manyTodos(13).map((item) => ({ ...item, id: item.id + 2 })),
    ]);
    expect(mixed).toHaveLength(TODOS_PANEL_LINES);
    expect(mixed.some((line) => line.includes("finished"))).toBe(false);
    expect(mixed.at(-1)).toBe("⋮ 7 more · 2 completed, 5 pending");
  });

  test("a list that fits shows every row, however many it is under the budget", () => {
    const rows = todoLines(manyTodos(TODOS_PANEL_LINES - 1));
    expect(rows).toHaveLength(TODOS_PANEL_LINES);
    expect(rows.at(-1)).toBe("  ○ #9 todo 9");
  });

  test("a narrow panel cuts every line to the width", () => {
    const rows = todoLines([todo(1, "completed", "a long todo's words that will not fit"), todo(2, "pending")], 24);
    expect(rows.every((line) => line.length <= 24)).toBe(true);
    expect(rows[1]).toContain("…");
  });

  test("the ascii glyph set keeps every row's meaning", () => {
    const ascii = { ...api, glyphs: glyphsFor("ascii") };
    const rows = todosLines(ascii, { todos: [todo(1, "completed"), todo(2, "pending")], frame: 0 }, 80);
    expect(rows[0]).toBe("* Todos 1/2  #-");
    expect(rows[1]).toBe("  x #1 todo 1");
    expect(rows[2]).toBe("  o #2 todo 2");
  });

  test("a session with no todos draws nothing, so the caller leaves any panel alone", () => {
    expect(todoLines([])).toEqual([]);
  });
});

describe("todo rows", () => {
  test("the title names the action and its row; the class joins the group vocabulary", () => {
    expect(describeCall("todo", { action: "start", id: 2 }).title).toBe("start #2");
    expect(describeCall("todo", { action: "add" }).title).toBe("add");
    expect(toolMeta("todo").cls).toBe("todo");
    expect(groupNoun("todo")).toBe("todo");
    expect(groupVerb("todo", 2)).toBe("updated 2 todos");
  });

  test("the row keeps pi-ui's header and puts the list's confirmation under it", () => {
    const rows = renderToolRow(api, {
      name: "todo",
      args: { action: "start", id: 2 },
      status: "success",
      level: 0,
      output: "Started #2: Committing the replay harness",
    }).render(80);
    expect(rows[0]).toStartWith("● todo · start #2");
    expect(rows[1]).toBe("    Started #2: Committing the replay harness");
  });
});
