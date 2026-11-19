import { describe, expect, test } from "bun:test";
import { glyphsFor } from "./glyphs.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";
import { createPiKit } from "./pi-kit.ts";
import { highlightShellLines, shellView } from "./shell-output.ts";
import { leavingRow, previewLineCount, renderToolRow, toolRowLayout, type ToolRowInput } from "./tool-row.ts";

const LANGUAGES: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", json: "json" };
const languageFromPath = (path: string) => LANGUAGES[/\.(\w+)$/.exec(path)?.[1] ?? ""];

/** Every highlight call, so a test can see which lines went to the grammar together. */
let calls: Array<{ source: string; language: string }> = [];

/** Plain-text stand-ins; `highlight` tags each line with its language. */
const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") =>
    line.length <= width ? line : line.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis,
  wrap: (text) => text.split("\n"),
  visibleWidth: (text) => text.length,
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
  languageFromPath,
  highlight(source, language) {
    calls.push({ source, language });
    return source.split("\n").map((line) => `<${language}>${line}`);
  },
};

const theme: RenderTheme = {
  fg: (_token, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  style: (text) => text,
};
const api = { kit, theme, glyphs: glyphsFor("unicode") };

/** An opened shell row's body rows, so the budget never hides a line. */
function shell(command: string, output: string, extra: Partial<ToolRowInput> = {}): string[] {
  calls = [];
  const input: ToolRowInput = {
    name: "bash",
    status: "success",
    level: 0,
    args: { command },
    output,
    expanded: true,
    full: true,
    ...extra,
  };
  return renderToolRow(api, input).render(100).slice(1);
}

const lines = (...rows: string[]) => rows.join("\n");

describe("grep output", () => {
  test("rg across files numbers each line, names each file once and marks the skipped lines", () => {
    const output = lines(
      "./x.ts:2:foo one",
      "./x.ts-3-b",
      "--",
      "./x.ts:8:foo two",
      "./x.ts-9-g",
      "--",
      "./y.py:1:foo",
    );
    expect(shell("rg -n -A1 foo .", output)).toEqual([
      "    ./x.ts",
      "    2  <typescript>foo one",
      "    3  <typescript>b",
      "    ⋮",
      "    8  <typescript>foo two",
      "    9  <typescript>g",
      "    ./y.py",
      "    1  <python>foo",
    ]);
    // Each run of adjacent lines of one file is one source, so a comment that spans them reads right.
    expect(calls).toEqual([
      { source: "foo one\nb", language: "typescript" },
      { source: "foo two\ng", language: "typescript" },
      { source: "foo", language: "python" },
    ]);
  });

  test("rg of one file takes its language from the command, through a pipe into head", () => {
    const output = lines(
      "984:    getRenderContext() {",
      "985-        if (x) {",
      '986:        else if (event.type === "message_update") {',
      "--",
      "1201:  getRenderContext(y)",
    );
    const command = "rg -n -A2 'getRenderContext\\(' dist/agent-session.js | head";
    expect(shell(command, output)).toEqual([
      "     984  <javascript>    getRenderContext() {",
      "     985  <javascript>        if (x) {",
      '     986  <javascript>        else if (event.type === "message_update") {',
      "       ⋮",
      "    1201  <javascript>  getRenderContext(y)",
    ]);
    expect(calls.map(({ language }) => language)).toEqual(["javascript", "javascript"]);
  });

  test("a context line of a file whose name holds a dash is read against the paths of its matches", () => {
    const output = lines("src/agent-session.js-285-  this.removeChild(spacer);", "src/agent-session.js:286:  done();");
    expect(shell("grep -rn -B1 done src", output)).toEqual([
      "    src/agent-session.js",
      "    285  <javascript>  this.removeChild(spacer);",
      "    286  <javascript>  done();",
    ]);
  });

  test("a blank context line keeps its number but takes no row", () => {
    expect(shell("rg -n -C1 foo a.ts", lines("1-", "2:foo", "3-bar"))).toEqual([
      "    2  <typescript>foo",
      "    3  <typescript>bar",
    ]);
    expect(calls).toEqual([{ source: "\nfoo\nbar", language: "typescript" }]);
  });

  test("grep without numbers highlights one file's lines and names many files", () => {
    expect(shell("grep foo src/a.ts", lines("const foo = 1;", "foo();"))).toEqual([
      "    <typescript>const foo = 1;",
      "    <typescript>foo();",
    ]);
    expect(shell("grep -r foo src", lines("src/a.ts:const foo = 1;", "src/b.py:foo()"))).toEqual([
      "    src/a.ts",
      "    <typescript>const foo = 1;",
      "    src/b.py",
      "    <python>foo()",
    ]);
  });

  test("git grep always names the file", () => {
    expect(shell("git grep -n foo -- '*.ts'", lines("a.ts:3:foo()", "b.ts:4:foo()"))).toEqual([
      "    a.ts",
      "    3  <typescript>foo()",
      "    b.ts",
      "    4  <typescript>foo()",
    ]);
  });

  test("ag is read only when its command says whether it numbers its lines", () => {
    expect(shell("ag --numbers foo src", lines("src/a.ts:3:foo()"))).toEqual([
      "    src/a.ts",
      "    3  <typescript>foo()",
    ]);
    expect(shell("ag --nonumbers foo src/a.ts", lines("foo()"))).toEqual(["    <typescript>foo()"]);
    expect(shell("ag foo src", lines("src/a.ts:3:foo()"))).toEqual(["    src/a.ts:3:foo()"]);
  });

  test("one operand prints paths when it is a directory and bare lines when it is a file", () => {
    expect(shell("rg -n foo src", lines("src/a.ts:3:foo()"))).toEqual(["    src/a.ts", "    3  <typescript>foo()"]);
    expect(shell("rg -n foo src/a.ts", lines("3:foo()"))).toEqual(["    3  <typescript>foo()"]);
  });

  test("options that change the prefix leave the output as it came", () => {
    const output = lines("a.ts:3:7:foo()", "b.ts:2");
    for (const command of [
      "rg -n --json foo",
      "rg -c foo",
      "grep -rnl foo .",
      "rg -no foo",
      "rg --vimgrep foo",
      "grep -nb foo a.ts",
      "rg -n --column foo",
      "rg -n --heading foo",
      "rg -n foo > out.txt",
      "rg -n foo; echo done",
      'rg -n "$(cat pattern)" a.ts',
      "rg -n foo | wc -l",
      "rg -n foo | uniq -c",
    ]) {
      expect(shell(command, output)).toEqual(["    a.ts:3:7:foo()", "    b.ts:2"]);
      expect(calls).toEqual([]);
    }
  });

  test("a pattern may hold a pipe, and stderr may go away", () => {
    expect(shell("cd pkg && rg -n 'a|b' src/a.ts 2>/dev/null | head -5", "3:a()")).toEqual(["    3  <typescript>a()"]);
  });

  test("a time stamp is a line number only when grep was asked for numbers", () => {
    const log = lines("12:34:56 started", "12:35:01 error: boom");
    // A grep without -n prints the lines as they are.
    expect(shell("grep error app.log", "12:35:01 error: boom")).toEqual(["    12:35:01 error: boom"]);
    expect(shell("rg error logs", "logs/app.log:12:35:01 error: boom")).toEqual([
      "    logs/app.log",
      "    12:35:01 error: boom",
    ]);
    // Neither a log tail nor an arbitrary command is read for numbers.
    expect(shell("tail -n 20 app.log", log)).toEqual(["    12:34:56 started", "    12:35:01 error: boom"]);
    expect(shell("npm run build", log)).toEqual(["    12:34:56 started", "    12:35:01 error: boom"]);
  });

  test("lines grep did not write stay plain, and pi's cut keeps the numbers grep printed", () => {
    const output = lines("4:foo()", "", "", "[Showing lines 9-10 of 10. Full output: /tmp/pi-bash.log]");
    expect(shell("rg -n foo a.ts", output)).toEqual([
      "    4  <typescript>foo()",
      "    [Showing lines 9-10 of 10. Full output: /tmp/pi-bash.log]",
    ]);
  });

  test("a tail preview names the file of its first line", () => {
    const output = Array.from({ length: 12 }, (_, index) => `${index < 6 ? "a" : "b"}.ts:${index + 1}:line ${index}`);
    const rows = shell("rg -n line", lines(...output), { expanded: false, full: false, level: 4 });
    expect(rows).toEqual([
      "     ↑  10 more lines",
      "    b.ts",
      "    11  <typescript>line 10",
      "    12  <typescript>line 11",
    ]);
  });

  test("the fade compares rows by source line, past the path rows", () => {
    const output = Array.from({ length: 12 }, (_, index) => `${index < 6 ? "a" : "b"}.ts:${index + 1}:line ${index}`);
    const input: ToolRowInput = {
      name: "bash",
      status: "success",
      level: 3,
      args: { command: "rg -n line" },
      output: lines(...output),
    };
    const layout = toolRowLayout(api, input, 100);
    // The first code row, under the notice and the path row, is the one the next level drops.
    expect(layout.rows[leavingRow(api, input, 100)!]).toBe("    10  <typescript>line 9");
    expect(layout.sources).toEqual([undefined, undefined, 9, 10, 11]);
    expect(layout.bar).toHaveLength(5);
  });
});

describe("single-file commands", () => {
  test("head numbers from 1, alone or after cat", () => {
    expect(shell("head -n 2 src/a.ts", lines("one", "two"))).toEqual([
      "    1  <typescript>one",
      "    2  <typescript>two",
    ]);
    expect(shell("cat src/a.ts | head -50", lines("one", "two"))).toEqual([
      "    1  <typescript>one",
      "    2  <typescript>two",
    ]);
    expect(calls).toEqual([{ source: "one\ntwo", language: "typescript" }]);
  });

  test("a range keeps its start through head, and tail -n +K starts at K", () => {
    expect(shell("sed -n '120,200p' src/a.ts | head -2", lines("one", "two"))).toEqual([
      "    120  <typescript>one",
      "    121  <typescript>two",
    ]);
    expect(shell("awk 'NR>=40 && NR<=41' src/a.ts", lines("one", "two"))).toEqual([
      "    40  <typescript>one",
      "    41  <typescript>two",
    ]);
    expect(shell("tail -n +40 src/a.ts", "one")).toEqual(["    40  <typescript>one"]);
    expect(shell("bat --plain -r 7:9 src/a.ts", "seven")).toEqual(["    7  <typescript>seven"]);
    // Several ranges print discontinuous lines: highlighted, but no numbers to invent.
    expect(shell("bat --plain -r 1:2 -r 10:11 src/a.ts", lines("one", "ten"))).toEqual([
      "    <typescript>one",
      "    <typescript>ten",
    ]);
    expect(shell("bat --plain -r 10:11 --line-range 1:2 src/a.ts", "one")).toEqual(["    <typescript>one"]);
    expect(shell("sed -n '10,20p' src/a.ts | sed -n '3,4p'", "twelve")).toEqual(["    12  <typescript>twelve"]);
  });

  test("tail highlights without numbers: its first line is not known", () => {
    expect(shell("tail -n 2 src/a.ts", lines("one", "two"))).toEqual(["    <typescript>one", "    <typescript>two"]);
    expect(shell("cat src/a.ts | tail -5", "one")).toEqual(["    <typescript>one"]);
  });

  test("nl's own numbers move into the gutter, and blank lines it left unnumbered take no row", () => {
    expect(shell("nl src/a.ts", lines("     1\tone", "       ", "     2\t  two"))).toEqual([
      "    1  <typescript>one",
      "    2  <typescript>  two",
    ]);
    expect(calls).toEqual([{ source: "one\n\n  two", language: "typescript" }]);
    expect(shell("cat -n src/a.ts | sed -n '2,3p'", lines("     2\ttwo", "     3\tthree"))).toEqual([
      "    2  <typescript>two",
      "    3  <typescript>three",
    ]);
  });

  test("a pipeline that reorders or rewrites the file is not read", () => {
    for (const command of [
      "cat src/a.ts | sort",
      "head src/a.ts | grep x",
      "cat a.ts b.ts",
      "cat src/*.ts",
      "nl -s: a.ts",
    ]) {
      expect(shell(command, lines("one", "two"))).toEqual(["    one", "    two"]);
    }
  });

  test("a running or cut output highlights without numbers", () => {
    expect(shell("cat src/a.ts", "one", { status: "running" })).toEqual(["    <typescript>one"]);
    const cut = lines("late", "", "", "[Showing lines 1999-2000 of 2000. Full output: /tmp/pi-bash.log]");
    expect(shell("cat src/a.ts", cut)).toEqual([
      "    <typescript>late",
      "    [Showing lines 1999-2000 of 2000. Full output: /tmp/pi-bash.log]",
    ]);
  });

  test("a file named for no language is highlighted as JSON when it parses", () => {
    expect(shell("cat config", '{"a": 1}')).toEqual(['    1  <json>{"a": 1}']);
  });
});

/** The sources a view's lines are highlighted from, in order. */
function sourcesOf(command: string, output: string): string[] {
  const found: string[] = [];
  highlightShellLines(shellView(command, output, { complete: true, languageFromPath })!.lines, (source) => {
    found.push(source);
    return source.split("\n");
  });
  return found;
}

/** The rows a shell output's lines take with nothing hidden. */
const lineCount = (command: string, output: string) =>
  previewLineCount({ name: "bash", status: "success", level: 0, args: { command }, output });

describe("line count", () => {
  test("lines a shell output gives no row do not count toward opening the block", () => {
    // A blank context line and the `--` between two files take no row.
    expect(lineCount("rg -n -C1 x", lines("a.ts-1-", "a.ts:2:x", "--", "b.ts:5:x"))).toBe(2);
    expect(lineCount("cat -n a.ts", lines("     1\tone", "     2\t", "     3\tthree"))).toBe(2);
    expect(lineCount("npm test", lines("one", "", "--", "two"))).toBe(3);
  });
});

describe("highlight groups", () => {
  test("a plain line or another file starts a new source", () => {
    const view = shellView("rg -n x", lines("a.ts:1:one", "a.ts:2:two", "b.ts:1:three", "oops", "b.ts:4:four"), {
      complete: true,
      languageFromPath,
    })!;
    const sources: string[] = [];
    highlightShellLines(view.lines, (source) => {
      sources.push(source);
      return source.split("\n");
    });
    expect(sources).toEqual(["one\ntwo", "three", "four"]);
  });

  test("matches grep found apart in a file are highlighted apart", () => {
    expect(sourcesOf("rg -n x a.ts", lines("2:one", "3:two", "8:three"))).toEqual(["one\ntwo", "three"]);
    expect(sourcesOf("grep x a.ts", lines("one", "two"))).toEqual(["one", "two"]);
    expect(sourcesOf("grep -C1 x a.ts", lines("one", "two", "--", "three"))).toEqual(["one\ntwo", "three"]);
  });

  test("pi's kit highlights each group once per owner across renders and fades", () => {
    let count = 0;
    const piKit = createPiKit(
      {
        Markdown: undefined as never,
        truncateToWidth: kit.truncateToWidth,
        visibleWidth: kit.visibleWidth,
        wrapTextWithAnsi: kit.wrap,
      },
      {
        getLanguageFromPath: languageFromPath,
        getMarkdownTheme: (() => ({})) as never,
        highlightCode: (source: string) => {
          count++;
          return source.split("\n");
        },
      },
    );
    const owner = {};
    const piApi = { kit: piKit, theme, glyphs: glyphsFor("unicode"), owner };
    const input: ToolRowInput = {
      name: "bash",
      status: "success",
      level: 0,
      args: { command: "rg -n -A1 foo ." },
      output: lines("./a.ts:1:foo", "./a.ts-2-x", "--", "./a.ts:9:foo", "./b.py:1:foo"),
    };
    toolRowLayout(piApi, input, 80);
    toolRowLayout(piApi, input, 80);
    leavingRow(piApi, input, 80);
    expect(count).toBe(3);
  });

  test("pi's kit keeps an owner's sources up to one render's worth, and a hit never clears them", () => {
    let count = 0;
    const piKit = createPiKit(
      {
        Markdown: undefined as never,
        truncateToWidth: kit.truncateToWidth,
        visibleWidth: kit.visibleWidth,
        wrapTextWithAnsi: kit.wrap,
      },
      {
        getLanguageFromPath: languageFromPath,
        getMarkdownTheme: (() => ({})) as never,
        highlightCode: (source: string) => {
          count++;
          return source.split("\n");
        },
      },
    );
    const owner = {};
    const [a, b, c] = ["a".repeat(30_000), "b".repeat(30_000), "c".repeat(30_000)] as const;
    for (const source of [a, b, a, b]) piKit.highlight!(source, "typescript", theme, owner);
    expect(count).toBe(2);
    // A third source would pass the bound: the owner starts over with it.
    piKit.highlight!(c, "typescript", theme, owner);
    piKit.highlight!(a, "typescript", theme, owner);
    expect(count).toBe(4);
  });
});
