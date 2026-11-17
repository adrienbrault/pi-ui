/**
 * Build the gallery: render every registry cell against the live pi install,
 * then emit index.html, spec.json and ANSI fixtures.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRIES, GLYPH_MODES, THEME_NAMES, WIDTHS, type EntryDef } from "./registry.ts";
import { resolvePi } from "./lib/pi.ts";
import { createKit, toHtml } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";
import { BODY_LINES } from "../packages/pi-prism/render/detail.ts";
import { renderPage, type PagePayload } from "./html.ts";

const OUT = join(process.cwd(), "design-system", "web");
const FIXTURES = join(process.cwd(), "design-system", "fixtures");

type CellKey = string; // `${width}/${theme}/${glyph}`

interface EntryData {
  states: Record<string, Record<CellKey, string[]>>;
}

function cellKey(width: number, theme: string, glyph: string): CellKey {
  return `${width}/${theme}/${glyph}`;
}

function short(entry: EntryDef) {
  return {
    id: entry.id,
    title: entry.title,
    group: entry.group,
    variant: entry.variant,
    description: entry.description,
    states: entry.states.map((s) => ({
      id: s.id,
      label: s.label,
      ...(s.note ? { note: s.note } : {}),
      frames: s.frames ?? 1,
    })),
  };
}

async function main(): Promise<void> {
  const pi = await resolvePi();
  console.log(`pi ${pi.version} (${pi.source}) · tui ${pi.tuiVersion}`);

  const entries = ENTRIES.map(short);
  const data = new Map<string, EntryData>();
  const fixtures = new Map<string, Record<string, { lines: string[] }>>();
  const themes: PagePayload["themes"] = {};

  for (const themeName of THEME_NAMES) {
    const installed = installTheme(pi, loadThemeJson(pi, themeName));
    const themeModule = pi.modules.theme;
    const palette = themeModule.getResolvedThemeColors(themeName) as Record<string, string>;
    const exportColors = themeModule.getThemeExportColors(themeName) as {
      pageBg?: string;
      cardBg?: string;
    };
    themes[themeName] = {
      pageBg: exportColors.pageBg ?? palette.toolPendingBg ?? "#121016",
      cardBg: exportColors.cardBg ?? palette.toolPendingBg ?? "#17141d",
      palette,
    };

    const kit = createKit(pi);

    for (const entry of ENTRIES) {
      const entryData: EntryData = data.get(entry.id) ?? { states: {} };
      const fixtureEntry: Record<string, { lines: string[] }> = fixtures.get(entry.id) ?? {};

      for (const state of entry.states) {
        const byCell: Record<CellKey, string[]> = {};
        for (const width of WIDTHS) {
          for (const glyphMode of GLYPH_MODES) {
            const ctx = {
              pi,
              kit,
              theme: installed.theme,
              glyphs: glyphsFor(glyphMode),
              glyphMode,
              width,
              themeName,
            };
            const frames: string[] = [];
            const frameCount = state.frames ?? 1;
            for (let frame = 0; frame < frameCount; frame++) {
              const lines = state.render(ctx, frame);
              frames.push(toHtml(pi, lines));
              if (frame === 0) {
                fixtureEntry[`${state.id}/${themeName}/${width}/${glyphMode}`] = { lines };
              }
            }
            byCell[cellKey(width, themeName, glyphMode)] = frames;
          }
        }
        // Merge: each theme contributes its own cell keys to the same state.
        entryData.states[state.id] = { ...entryData.states[state.id], ...byCell };
      }

      data.set(entry.id, entryData);
      fixtures.set(entry.id, fixtureEntry);
    }
  }

  // Fail loudly if any cell is missing: a silent hole is how the gallery shipped empty once.
  for (const entry of ENTRIES) {
    for (const state of entry.states) {
      for (const themeName of THEME_NAMES) {
        for (const width of WIDTHS) {
          for (const glyphMode of GLYPH_MODES) {
            const cell = data.get(entry.id)?.states[state.id]?.[cellKey(width, themeName, glyphMode)];
            const expected = state.frames ?? 1;
            if (!cell || cell.length !== expected) {
              throw new Error(`missing cell for ${entry.id}/${state.id} at ${cellKey(width, themeName, glyphMode)}`);
            }
          }
        }
      }
    }
  }

  const payload: PagePayload = {
    meta: {
      piVersion: pi.version,
      tuiVersion: pi.tuiVersion,
      source: pi.source,
      generatedAt: new Date().toISOString(),
      widths: [...WIDTHS],
      glyphs: [...GLYPH_MODES],
      themes: [...THEME_NAMES],
      bodyLines: BODY_LINES,
    },
    themes,
    entries: entries.map((entry) => ({
      ...entry,
      data: data.get(entry.id)?.states ?? {},
    })),
  };

  const framesJson = JSON.stringify(Object.fromEntries(fixtures), null, 2);

  // --check: fail when committed fixtures no longer match what the components render.
  // This is the drift guard: the gallery cannot silently disagree with the code.
  if (process.argv.includes("--check")) {
    const committedPath = join(FIXTURES, "frames.json");
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
    const cells = entries.reduce(
      (sum, entry) => sum + entry.states.length * WIDTHS.length * GLYPH_MODES.length * THEME_NAMES.length,
      0,
    );
    console.log(`fixtures current: ${cells} cells across ${entries.length} entries`);
    return;
  }

  mkdirSync(OUT, { recursive: true });
  mkdirSync(FIXTURES, { recursive: true });

  writeFileSync(join(OUT, "index.html"), renderPage(payload));
  writeFileSync(join(OUT, "spec.json"), JSON.stringify({ meta: payload.meta, entries }, null, 2));
  writeFileSync(join(FIXTURES, "frames.json"), framesJson);

  const cells = entries.reduce(
    (sum, entry) => sum + entry.states.length * WIDTHS.length * GLYPH_MODES.length * THEME_NAMES.length,
    0,
  );
  console.log(`rendered ${cells} cells across ${entries.length} entries`);
  console.log(`wrote ${join(OUT, "index.html")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
