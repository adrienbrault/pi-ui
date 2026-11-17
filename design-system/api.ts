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
let queue: Promise<void> = Promise.resolve();

export const DEFAULT_TAIL = DEFAULT_TAIL_LINES;

const keyOf = (query: CellQuery): string => `${query.tail}/${query.theme}/${query.glyph}`;

export async function cellsFor(query: CellQuery): Promise<string> {
  const key = keyOf(query);
  const hit = cache.get(key);
  if (hit) return hit;

  let body = "";
  // Serialise renders: the tail knob is process state, so two builds must not interleave.
  queue = queue.then(async () => {
    const again = cache.get(key);
    if (again) {
      body = again;
      return;
    }
    const { payload } = await renderGallery({
      tailLines: query.tail,
      themes: [query.theme],
      glyphModes: [query.glyph],
      entries: ENTRIES.filter((entry) => entry.variant === "ours"),
    });
    body = JSON.stringify({
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
  });
  await queue;
  return body;
}
