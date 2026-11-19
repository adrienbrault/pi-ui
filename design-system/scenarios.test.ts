import { beforeAll, expect, test } from "bun:test";
import { cleanOutput } from "../packages/pi-prism/render/text.ts";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";
import { ENTRIES, type RenderCtx } from "./registry.ts";
import { resolvePi, type PiInstall } from "./lib/pi.ts";
import { createKit } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";

let pi: PiInstall;
beforeAll(async () => {
  pi = await resolvePi();
});

function render(entry: string, state: string, width = 80): string[] {
  const { theme } = installTheme(pi, loadThemeJson(pi, "dark"));
  const ctx: RenderCtx = {
    pi,
    kit: createKit(pi),
    theme,
    glyphs: glyphsFor("unicode"),
    glyphMode: "unicode",
    width,
    themeName: "dark",
  };
  const def = ENTRIES.find((candidate) => candidate.id === entry)?.states.find((candidate) => candidate.id === state);
  if (!def) throw new Error(`no ${entry} ${state}`);
  return def.render(ctx, 0).map((row) => cleanOutput(row).trimEnd());
}

test("an opened mixed group lists every member under its summary, thoughts in place, two columns in", () => {
  const rows = render("scenario.fold", "opened");
  const summary = rows.findIndex((row) => row.includes("Thought"));
  expect(summary).toBeGreaterThanOrEqual(0);
  const members = rows.slice(summary + 1, summary + 7);
  expect(members.every((row) => /^ {2}\S/.test(row))).toBe(true);
  const order = ["think · Start from the", "read", "grep", "bash", "think · The test pinned", "edit"];
  members.forEach((row, index) => expect(row).toContain(order[index]!));
  // A table: think, read, grep, bash and edit fill one label column, so every description starts together.
  expect(new Set(members.map((row) => row.indexOf(" · ")))).toEqual(new Set([members[0]!.indexOf(" · ")]));
  expect(members[1]).toMatch(/^ {2}. read  · /);
  // The member list ends at the next block's blank separator.
  expect(rows[summary + 7]).toBe("");
});

test("a collapsed mixed group is one summary row with the failure counted", () => {
  const rows = render("scenario.fold", "collapsed");
  const summary = rows.findIndex((row) => row.includes("Thought"));
  expect(rows[summary]).toContain("1 failed");
  expect(rows[summary + 1]).toBe("");
});
