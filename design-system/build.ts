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
import { createKit, toRows } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";
import { glyphsFor, type GlyphMode } from "../packages/pi-prism/render/glyphs.ts";
import { bodyLinesMap, setTailLines } from "../packages/pi-prism/render/detail.ts";
import { renderPage, type PagePayload } from "./html.ts";

const OUT = join(process.cwd(), "design-system", "web");
const FIXTURES = join(process.cwd(), "design-system", "fixtures");

type CellKey = string; // `${width}/${theme}/${glyph}`

interface RevealCell {
  header: string;
  members: Array<{ collapsed: string; preview: string; expanded: string }>;
}

/** Blocks outside a group: the collapsed row span and the body that replaces it. */
interface BlockCell {
  /** Full bodies, deduplicated by content. */
  pool: Record<string, string>;
  /** Per frame: which rows a click opens, the pool keys per click, and its id. */
  frames: Array<Array<{ row: number; count: number; id: string; keys: string[] }>>;
}

/** Content hash: identical bodies share one pool entry across frames. */
function contentKey(html: string): string {
  let hash = 5381;
  for (let index = 0; index < html.length; index++) hash = (hash * 33) ^ html.charCodeAt(index);
  return (hash >>> 0).toString(36) + ":" + html.length.toString(36);
}

interface EntryData {
  states: Record<string, Record<CellKey, string[]>>;
}

// oxlint-disable-next-line no-control-regex -- escape sequences are the input domain
const ANSI = /\x1b\[[\d;]*m/g;
const GROUP_VERB = /^(Read|Searched|Wrote|Edited|Ran|Fetched|Called)\b/;

/** Rows a click can open: the collapsed group lines in a rendered block. */
function groupRowIndices(lines: string[], marker: string): number[] {
  const indices: number[] = [];
  lines.forEach((line, index) => {
    const text = line.replace(ANSI, "").trimStart();
    const marked = marker !== "" && text.startsWith(marker);
    if (marked || GROUP_VERB.test(text)) indices.push(index);
  });
  return indices;
}

/** Tag group rows with their reveal index so a click knows which group it opens. */
function markRows(rows: string[], indices: number[]): string[] {
  if (indices.length === 0) return rows;
  const byRow = new Map(indices.map((row, order) => [row, order]));
  return rows.map((row, index) => {
    const order = byRow.get(index);
    if (order === undefined) return row;
    return row.replace('<div class="ansi-line"', `<div class="ansi-line" data-expand="${order}"`);
  });
}

/** Tag every row of a member block, and every row of a revealed header. */
function tagRows(rows: string[], name: string, value: string): string[] {
  return rows.map((row) => row.replace('<div class="ansi-line"', `<div class="ansi-line" ${name}="${value}"`));
}

/** Frames above this size share rows through a pool instead of repeating HTML. */
const POOL_FRAME_THRESHOLD = 16;

interface PooledCell {
  rows: string[];
  frames: number[][];
}

function pooled(frames: string[][]): PooledCell {
  const rows: string[] = [];
  const index = new Map<string, number>();
  const encoded = frames.map((frame) =>
    frame.map((row) => {
      const known = index.get(row);
      if (known !== undefined) return known;
      const next = rows.length;
      rows.push(row);
      index.set(row, next);
      return next;
    }),
  );
  return { rows, frames: encoded };
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
    ...(entry.frameCosts ? { frameCosts: entry.frameCosts } : {}),
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
  const revealData = new Map<string, Record<string, Record<CellKey, RevealCell[][]>>>();
  const blockData = new Map<string, Record<string, Record<CellKey, BlockCell>>>();
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
      const revealEntry: Record<string, Record<CellKey, RevealCell[][]>> = revealData.get(entry.id) ?? {};
      const blockEntry: Record<string, Record<CellKey, BlockCell>> = blockData.get(entry.id) ?? {};
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
            const frameCount = state.frames ?? 1;
            const frameRows: string[][] = [];
            const sharedReveal: RevealCell[][] = [];
            const blockPool: Record<string, string> = {};
            const blockFrames: BlockCell["frames"] = [];
            for (let frame = 0; frame < frameCount; frame++) {
              const lines = state.render(ctx, frame);
              const rows = toRows(pi, lines);
              // Blocks outside a group: a click swaps the span for its full body.
              const opened = (state.toggles ? state.toggles(ctx, frame) : []).map((spec) => {
                const keys = spec.opens.map((bodyLines) => {
                  const body = toRows(pi, bodyLines);
                  const key = contentKey(body.join(""));
                  blockPool[key] ??= tagRows(body, "data-block", spec.key).join("");
                  return key;
                });
                return { row: spec.row, count: spec.count, id: spec.key, keys };
              });
              opened.forEach(({ row, count, id }) => {
                for (let at = row; at < row + count; at++) {
                  const line = rows[at];
                  if (line === undefined) continue;
                  rows[at] = line.replace('<div class="ansi-line"', `<div class="ansi-line" data-block="${id}"`);
                }
              });
              blockFrames.push(opened);
              frameRows.push(state.reveal ? markRows(rows, groupRowIndices(lines, ctx.glyphs.collapsed)) : rows);
              if (state.reveal) {
                sharedReveal.push(
                  state.reveal(ctx, frame).map((group, gi) => ({
                    header: tagRows(toRows(pi, group.header), "data-collapse", String(gi)).join(""),
                    members: group.members.map((member, mi) => ({
                      collapsed: tagRows(toRows(pi, member.collapsed), "data-turn", `${gi}:${mi}`).join(""),
                      preview: tagRows(toRows(pi, member.preview), "data-turn", `${gi}:${mi}`).join(""),
                      expanded: tagRows(toRows(pi, member.expanded), "data-turn", `${gi}:${mi}`).join(""),
                    })),
                  })),
                );
              }
              if (frame === 0 && entry.fixture !== false) {
                fixtureEntry[`${state.id}/${themeName}/${width}/${glyphMode}`] = { lines };
              }
            }
            const key = cellKey(width, themeName, glyphMode);
            const pool = frameCount > POOL_FRAME_THRESHOLD;
            byCell[key] = pool ? (pooled(frameRows) as unknown as string[]) : frameRows.map((rows) => rows.join(""));
            if (state.reveal) {
              revealEntry[state.id] = { ...revealEntry[state.id], [key]: sharedReveal };
            }
            if (blockFrames.some((frame) => frame.length > 0)) {
              blockEntry[state.id] = { ...blockEntry[state.id], [key]: { pool: blockPool, frames: blockFrames } };
            }
          }
        }
        // Merge: each theme contributes its own cell keys to the same state.
        entryData.states[state.id] = { ...entryData.states[state.id], ...byCell };
      }

      data.set(entry.id, entryData);
      if (Object.keys(revealEntry).length > 0) revealData.set(entry.id, revealEntry);
      if (Object.keys(blockEntry).length > 0) blockData.set(entry.id, blockEntry);
      if (entry.fixture !== false) fixtures.set(entry.id, fixtureEntry);
    }
  }

  // Fail loudly if any cell is missing: a silent hole is how the gallery shipped empty once.
  for (const entry of entries) {
    for (const state of entry.states) {
      for (const themeName of themeNames) {
        for (const width of widthsFor(entry, scope)) {
          for (const glyphMode of glyphsForScope(scope)) {
            const cell = data.get(entry.id)?.states[state.id]?.[cellKey(width, themeName, glyphMode)] as
              | string[]
              | PooledCell
              | undefined;
            const expected = state.frames ?? 1;
            const actual = cell && Array.isArray(cell) ? cell.length : cell?.frames.length;
            if (!cell || actual !== expected) {
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
      ...(revealData.get(entry.id) ? { reveal: revealData.get(entry.id) } : {}),
      ...(blockData.get(entry.id) ? { blocks: blockData.get(entry.id) } : {}),
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
