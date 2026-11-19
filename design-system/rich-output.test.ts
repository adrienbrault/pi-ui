import { beforeEach, afterEach, expect, test } from "bun:test";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";
import { cleanOutput } from "../packages/pi-prism/render/text.ts";
import { thinkingLayout } from "../packages/pi-prism/render/thinking.ts";
import { renderToolRow } from "../packages/pi-prism/render/tool-row.ts";
import { resolvePi } from "./lib/pi.ts";
import { createKit } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";

import { DEFAULT_TAIL_LINES, setTailLines } from "../packages/pi-prism/render/detail.ts";
// Exercise the compact seven-row configuration used by these fixtures.
beforeEach(() => setTailLines(7));
afterEach(() => setTailLines(DEFAULT_TAIL_LINES));

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
      for (const [tool, args] of [
        ["read", { path: "file.ts" }],
        ["bash", { command: "cd /project && sed -n '2,4p' file.ts" }],
      ] as const) {
        const rows = renderToolRow(api, { name: tool, args, output: source, level: 0, status: "success" }).render(
          width,
        );
        expect(rows[2]).toContain(theme.fg("syntaxComment", "   continued */"));
        expect(rows[3]).toContain(keyword);
        expect(rows.map(cleanOutput).slice(1)).toEqual(source.split("\n").map((row) => "    " + row));
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
