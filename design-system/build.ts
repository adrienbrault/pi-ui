/**
 * Build the gallery: render every registry cell against the live pi install,
 * then emit index.html, spec.json and ANSI fixtures.
 *
 * `renderGallery` is exported so the dev server can re-render a slice at another
 * tail budget without duplicating the render path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRIES, GLYPH_MODES, THEME_NAMES, WIDTHS, type EntryDef } from "./registry.ts";
import { resolvePi, type PiInstall } from "./lib/pi.ts";
import { createKit, toHtml } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";
import { glyphsFor, type GlyphMode } from "../packages/pi-prism/render/glyphs.ts";
import { bodyLinesMap, setTailLines } from "../packages/pi-prism/render/detail.ts";
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
    ...(entry.sync ? { sync: entry.sync } : {}),
    ...(entry.stage ? { stage: entry.stage } : {}),
    ...(entry.frameLabels ? { frameLabels: entry.frameLabels } : {}),
    ...(entry.fixedWidth ? { fixedWidth: entry.fixedWidth } : {}),
    states: entry.states.map((s) => ({
      id: s.id,
      label: s.label,
      ...(s.note ? { note: s.note } : {}),
      frames: s.frames ?? 1,
    })),
  };
}

const widthsFor = (entry: EntryDef, scope: RenderScope): readonly number[] =>
  scope.widths ?? (entry.fixedWidth ? [entry.fixedWidth] : WIDTHS);

const glyphsForScope = (scope: RenderScope): readonly GlyphMode[] => scope.glyphModes ?? GLYPH_MODES;

/**
 * Render a slice of the gallery. `tailLines` moves the decay knob; the other
 * fields restrict the matrix so a live request stays small.
 */
type ThemeName = (typeof THEME_NAMES)[number];

export interface RenderScope {
  tailLines?: number;
  themes?: readonly ThemeName[];
  widths?: readonly number[];
  glyphModes?: readonly GlyphMode[];
  entries?: readonly EntryDef[];
}

export interface GalleryRender {
  payload: PagePayload;
  fixtures: Map<string, Record<string, { lines: string[] }>>;
  pi: PiInstall;
}

function cellCount(entries: readonly EntryDef[], scope: RenderScope): number {
  return entries.reduce(
    (sum, entry) =>
      sum +
      entry.states.length *
        widthsFor(entry, scope).length *
        glyphsForScope(scope).length *
        (scope.themes ?? THEME_NAMES).length,
    0,
  );
}

export async function renderGallery(scope: RenderScope = {}): Promise<GalleryRender> {
  if (scope.tailLines !== undefined) setTailLines(scope.tailLines);

  const pi = await resolvePi();
  const entries = scope.entries ?? ENTRIES;
  const themeNames = scope.themes ?? THEME_NAMES;
  const data = new Map<string, EntryData>();
  const fixtures = new Map<string, Record<string, { lines: string[] }>>();
  const themes: PagePayload["themes"] = {};

  for (const themeName of themeNames) {
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

    for (const entry of entries) {
      const entryData: EntryData = data.get(entry.id) ?? { states: {} };
      const fixtureEntry: Record<string, { lines: string[] }> = fixtures.get(entry.id) ?? {};

      for (const state of entry.states) {
        const byCell: Record<CellKey, string[]> = {};
        for (const width of widthsFor(entry, scope)) {
          for (const glyphMode of glyphsForScope(scope)) {
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
              if (frame === 0 && entry.fixture !== false) {
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
      if (entry.fixture !== false) fixtures.set(entry.id, fixtureEntry);
    }
  }

  // Fail loudly if any cell is missing: a silent hole is how the gallery shipped empty once.
  for (const entry of entries) {
    for (const state of entry.states) {
      for (const themeName of themeNames) {
        for (const width of widthsFor(entry, scope)) {
          for (const glyphMode of glyphsForScope(scope)) {
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
      bodyLines: bodyLinesMap(),
    },
    themes,
    entries: entries.map((entry) => ({
      ...short(entry),
      data: data.get(entry.id)?.states ?? {},
    })),
  };

  return { payload, fixtures, pi };
}

const scopeOfMain: RenderScope = {};

async function main(): Promise<void> {
  const { payload, fixtures, pi } = await renderGallery(scopeOfMain);
  console.log(`pi ${pi.version} (${pi.source}) · tui ${pi.tuiVersion}`);

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
    console.log(`fixtures current: ${cellCount(ENTRIES, scopeOfMain)} cells across ${payload.entries.length} entries`);
    return;
  }

  mkdirSync(OUT, { recursive: true });
  mkdirSync(FIXTURES, { recursive: true });

  writeFileSync(join(OUT, "index.html"), renderPage(payload));
  writeFileSync(join(OUT, "spec.json"), JSON.stringify({ meta: payload.meta, entries: payload.entries }, null, 2));
  writeFileSync(join(FIXTURES, "frames.json"), framesJson);

  console.log(`rendered ${cellCount(ENTRIES, scopeOfMain)} cells across ${payload.entries.length} entries`);
  console.log(`wrote ${join(OUT, "index.html")}`);
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
