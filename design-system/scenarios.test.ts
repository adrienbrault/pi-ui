import { beforeAll, expect, test } from "bun:test";
import { cleanOutput } from "../packages/pi-ui/render/text.ts";
import { glyphsFor } from "../packages/pi-ui/render/glyphs.ts";
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

/** Where each number on a row ends: right-aligned numbers of one column end together. */
const numbers = (row: string) => [...row.matchAll(/(?<= )[\d.]+k?(?:ms|s)?(?= |$)/g)].map((m) => m.index + m[0].length);

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
  // Its numbers are columns too: in, out and duration each end in the same place. Each column's word sits
  // on the first row that fills it: `out` on the first thought, `in` on the read; thoughts leave in blank.
  expect(new Set(members.map((row) => row.length)).size).toBe(1);
  const thought = numbers(members[0]!);
  const tool = numbers(members[1]!);
  expect(members[0]).toMatch(/ out 15 · +4\.2s$/);
  expect(members[1]).toMatch(/ in +60 +9 +380ms$/);
  expect(thought.slice(-2)).toEqual(tool.slice(-2));
  expect(
    members
      .slice(2)
      .filter((row) => row.includes("●") || row.includes("✗"))
      .every((row) => numbers(row).slice(-3).join() === tool.slice(-3).join()),
  ).toBe(true);
  // The member list ends at the next block's blank separator.
  expect(rows[summary + 7]).toBe("");
});

test("a collapsed mixed group is one summary row with the failure counted", () => {
  const rows = render("scenario.fold", "collapsed");
  const summary = rows.findIndex((row) => row.includes("Thought"));
  expect(rows[summary]).toContain("1 failed");
  expect(rows[summary + 1]).toBe("");
});

test("an opened group too narrow for its table leaves every member to its description", () => {
  const rows = render("scenario.fold", "opened", 50);
  const summary = rows.findIndex((row) => row.includes("Thought"));
  const members = rows.slice(summary + 1, summary + 7);
  expect(members.some((row) => row.includes("out "))).toBe(false);
  expect(members[0]).toMatch(/^ {2}✻ think · Start from the pla/);
  expect(members[1]).toBe("  ● read  · extensions/fold.ts");
});
