import { expect, test } from "bun:test";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";
import { cleanOutput } from "../packages/pi-prism/render/text.ts";
import { thinkingLayout } from "../packages/pi-prism/render/thinking.ts";
import { renderToolRow } from "../packages/pi-prism/render/tool-row.ts";
import { MAX_FULL_LINES } from "../packages/pi-prism/render/detail.ts";
import { resolvePi } from "./lib/pi.ts";
import { createKit } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";

test("reads, shell file previews and Markdown thoughts use pi's active syntax palette", async () => {
  const pi = await resolvePi();
  const kit = createKit(pi);
  const owner = {};
  for (const name of ["dark", "light"] as const) {
    const { theme } = installTheme(pi, loadThemeJson(pi, name));
    const api = { kit, theme, glyphs: glyphsFor("unicode"), owner };
    const source = "/* comment\n   continued */\nconst value = 42;";
    const keyword = theme.fg("syntaxKeyword", "const");
    for (const width of [40, 80, 120]) {
      for (const [tool, args, first] of [
        ["read", { path: "file.ts" }, 1],
        ["bash", { command: "cd /project && sed -n '2,4p' file.ts" }, 2],
      ] as const) {
        const rows = renderToolRow(api, { name: tool, args, output: source, level: 0, status: "success" }).render(
          width,
        );
        expect(rows[2]).toContain(theme.fg("syntaxComment", "   continued */"));
        expect(rows[3]).toContain(keyword);
        // Each line follows its number in the file, from the read's start or sed's first line.
        expect(rows.map(cleanOutput).slice(1)).toEqual(
          source.split("\n").map((row, index) => `    ${first + index}  ${row}`),
        );
        expect(rows.every((row) => kit.visibleWidth(row) <= width)).toBe(true);
      }
      for (const patch of ["@@ -1 +1 @@\n-const old = 1;\n+const next = 2;", "-1 const old = 1;\n+1 const next = 2;"]) {
        const rows = renderToolRow(api, {
          name: "edit",
          args: { path: "example.ts" },
          output: patch,
          level: 0,
          status: "success",
        }).render(width);
        for (const [row, bg] of [
          [rows.at(-2)!, "toolErrorBg"],
          [rows.at(-1)!, "toolSuccessBg"],
        ] as const) {
          expect(row).toContain(keyword);
          expect(row).toContain(theme.style("probe", { bg }).split("probe")[0]!);
          expect(kit.visibleWidth(row)).toBe(width);
        }
      }
      const thought = {
        text: ["**Plan**", "", "- Check `value`.", "", "```ts", "const value = 42;", "```"].join("\n"),
        width,
        phase: "done" as const,
        level: 0 as const,
      };
      const expanded = thinkingLayout(api, { ...thought, expanded: true });
      expect(expanded.label).toContain(keyword);
      expect(cleanOutput(expanded.label)).toContain("Check value.");
      expect(cleanOutput(expanded.label)).not.toContain("**Plan**");
      expect(expanded.label.split("\n").every((row) => kit.visibleWidth(row) <= width)).toBe(true);
      expect(thinkingLayout(api, thought).canToggle).toBe(true);
      const plain = renderToolRow(api, {
        name: "bash",
        args: { command: "cat file.ts | sort" },
        output: source,
        status: "success",
        level: 0,
      }).render(width);
      expect(plain.join("\n")).not.toContain(keyword);
    }
  }
});

test("expanded rows wrap highlighted lines and edit backgrounds within the width and the row cap", async () => {
  const pi = await resolvePi();
  const kit = createKit(pi);
  const { theme } = installTheme(pi, loadThemeJson(pi, "dark"));
  const api = { kit, theme, glyphs: glyphsFor("unicode"), owner: {} };
  const long = `const values = [${Array.from({ length: 60 }, (_, index) => index).join(", ")}];`;
  for (const width of [40, 80, 120]) {
    const read = renderToolRow(api, {
      name: "read",
      args: { path: "file.ts" },
      output: long,
      level: 0,
      status: "success",
      expanded: true,
      full: true,
    }).render(width);
    expect(read.length).toBeGreaterThan(2);
    expect(read.length).toBeLessThanOrEqual(1 + MAX_FULL_LINES);
    expect(read.every((row) => kit.visibleWidth(row) <= width)).toBe(true);
    // The first row carries the line number; the wrapped rows leave its column blank.
    expect(cleanOutput(read[1]!)).toStartWith("    1  ");
    expect(read.slice(2).every((row) => cleanOutput(row).startsWith("       "))).toBe(true);
    expect(read.slice(1).map(cleanOutput).join("").replace(/\s+/g, "")).toBe(`1${long.replace(/\s+/g, "")}`);

    const edit = renderToolRow(api, {
      name: "edit",
      args: { path: "file.ts" },
      output: `@@ -1 +1 @@\n-${long}\n+${long.replace("values", "numbers")}`,
      level: 0,
      status: "success",
      expanded: true,
      full: true,
    }).render(width);
    expect(edit.slice(2).every((row) => kit.visibleWidth(row) === width)).toBe(true);
  }
});
