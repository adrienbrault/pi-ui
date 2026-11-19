// pi styles bold and italic through chalk; the gallery renders headless.
process.env.FORCE_COLOR ||= "3";

/**
 * Live re-render for the gallery's tail slider: the browser asks for cells at a
 * new tail budget and swaps them in, so the terminals update without a rebuild.
 * Only "ours" cards depend on the knob, so only they are re-rendered.
 */

import { renderGallery } from "./build.ts";
import { ENTRIES, THEME_NAMES } from "./registry.ts";
import { DEFAULT_TAIL_LINES } from "../packages/pi-prism/render/detail.ts";
import type { GlyphMode } from "../packages/pi-prism/render/glyphs.ts";

type ThemeName = (typeof THEME_NAMES)[number];

export interface CellQuery {
  tail: number;
  theme: ThemeName;
  glyph: GlyphMode;
}

const CACHE_LIMIT = 32;
const cache = new Map<string, string>();

/**
 * Run tasks one at a time, in call order. A rejected task rejects only its own
 * caller; the queue carries on, so one failed render cannot fail every later
 * request until the server restarts.
 */
export function serial(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

// The tail knob is process state, so two builds must not interleave.
const render = serial();

export const DEFAULT_TAIL = DEFAULT_TAIL_LINES;

const keyOf = (query: CellQuery): string => `${query.tail}/${query.theme}/${query.glyph}`;

export async function cellsFor(query: CellQuery): Promise<string> {
  const key = keyOf(query);
  const hit = cache.get(key);
  if (hit) return hit;

  return render(async () => {
    const again = cache.get(key);
    if (again) return again;
    const { payload } = await renderGallery({
      tailLines: query.tail,
      themes: [query.theme],
      glyphModes: [query.glyph],
      entries: ENTRIES.filter((entry) => entry.variant === "ours"),
    });
    const body = JSON.stringify({
      meta: {
        tail: query.tail,
        bodyLines: payload.meta.bodyLines,
        theme: query.theme,
        glyph: query.glyph,
      },
      entries: payload.entries,
    });
    cache.set(key, body);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return body;
  });
}
