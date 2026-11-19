// pi styles bold and italic through chalk; the fixtures render headless.
process.env.FORCE_COLOR ||= "3";

/**
 * Render every registry cell against the live pi install and write the golden
 * ANSI fixtures. `--check` compares instead of writing: the drift guard.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRIES, GLYPH_MODES, THEME_NAMES, WIDTHS, type RenderCtx } from "./registry.ts";
import { resolvePi } from "./lib/pi.ts";
import { createKit } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";

const FIXTURES = join(process.cwd(), "design-system", "fixtures");

type Fixtures = Map<string, Record<string, { lines: string[] }>>;

async function renderFixtures(): Promise<{ fixtures: Fixtures; cells: number; header: string }> {
  const pi = await resolvePi();
  const fixtures: Fixtures = new Map();
  let cells = 0;

  for (const themeName of THEME_NAMES) {
    const installed = installTheme(pi, loadThemeJson(pi, themeName));
    const kit = createKit(pi);

    for (const entry of ENTRIES) {
      const fixtureEntry = fixtures.get(entry.id) ?? {};
      for (const state of entry.states) {
        for (const width of WIDTHS) {
          for (const glyphMode of GLYPH_MODES) {
            const ctx: RenderCtx = {
              pi,
              kit,
              theme: installed.theme,
              glyphs: glyphsFor(glyphMode),
              glyphMode,
              width,
              themeName,
            };
            // Frame 0 is the golden; later frames still render so a broken one fails the build.
            fixtureEntry[`${state.id}/${themeName}/${width}/${glyphMode}`] = { lines: state.render(ctx, 0) };
            for (let frame = 1; frame < (state.frames ?? 1); frame++) state.render(ctx, frame);
            cells++;
          }
        }
      }
      fixtures.set(entry.id, fixtureEntry);
    }
  }

  return { fixtures, cells, header: `pi ${pi.version} (${pi.source}) · tui ${pi.tuiVersion}` };
}

async function main(): Promise<void> {
  const { fixtures, cells, header } = await renderFixtures();
  console.log(header);

  const framesJson = JSON.stringify(Object.fromEntries(fixtures), null, 2);
  const committedPath = join(FIXTURES, "frames.json");

  // --check: fail when committed fixtures no longer match what the components render.
  if (process.argv.includes("--check")) {
    const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : "";
    if (committed !== framesJson) {
      const next = Object.fromEntries(fixtures);
      const prev = committed ? (JSON.parse(committed) as Record<string, Record<string, unknown>>) : {};
      const drifted = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter(
        (id) => JSON.stringify(prev[id]) !== JSON.stringify(next[id]),
      );
      console.error(`stale fixtures: ${drifted.join(", ") || "whole file"}`);
      console.error("run `bun run ds` and commit the regenerated output");
      process.exitCode = 1;
      return;
    }
    console.log(`fixtures current: ${cells} cells across ${fixtures.size} entries`);
    return;
  }

  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(committedPath, framesJson);
  console.log(`rendered ${cells} cells across ${fixtures.size} entries`);
  console.log(`wrote ${committedPath}`);
}

if (import.meta.main) {
  // pi's imported modules leave handles open; exit explicitly so scripts finish.
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
