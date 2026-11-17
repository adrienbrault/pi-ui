/** Serve the generated gallery with Bun's HTTP server. */

import { DEFAULT_TAIL, cellsFor } from "./api.ts";
import { GLYPH_MODES, THEME_NAMES } from "./registry.ts";
import type { GlyphMode } from "../packages/pi-prism/render/glyphs.ts";

const DIST = `${import.meta.dir}/web`;
type ThemeName = (typeof THEME_NAMES)[number];

const clampInt = (raw: string | null, min: number, max: number, fallback: number): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const url = new URL(request.url);

    // The tail slider re-renders ours-cards at a new decay budget.
    if (url.pathname === "/api/cells") {
      const tail = clampInt(url.searchParams.get("tail"), 3, 12, DEFAULT_TAIL);
      const theme = url.searchParams.get("theme") ?? "dark";
      const glyph = url.searchParams.get("glyph") ?? "unicode";
      if (!THEME_NAMES.includes(theme as ThemeName) || !GLYPH_MODES.includes(glyph as GlyphMode)) {
        return Response.json({ error: "unknown theme or glyph set" }, { status: 400 });
      }
      try {
        const body = await cellsFor({ tail, theme: theme as ThemeName, glyph: glyph as GlyphMode });
        return new Response(body, {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${DIST}${path}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "cache-control": "no-store" },
      });
    }
    return new Response("No gallery yet. Run: bun run ds", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`design system on http://localhost:${server.port}`);
