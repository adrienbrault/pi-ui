import type * as Coding from "@earendil-works/pi-coding-agent";
import type * as Tui from "@earendil-works/pi-tui";
import type { RenderKit, RenderTheme } from "./kit.ts";
import { MAX_FORMAT_CHARS } from "./text.ts";

/** Both the gallery and the extension supply their own resolved pi modules. */
export function createPiKit(
  tui: Pick<typeof Tui, "Markdown" | "truncateToWidth" | "visibleWidth" | "wrapTextWithAnsi">,
  coding: Pick<typeof Coding, "getLanguageFromPath" | "getMarkdownTheme" | "highlightCode">,
): RenderKit {
  type Palette = RenderTheme["colors"];
  const code = new WeakMap<object, { palette: Palette; chars: number; rows: Map<string, string[]> }>();
  const markdown = new WeakMap<object, { source: string; palette: Palette; component: Tui.Markdown }>();
  return {
    truncateToWidth: tui.truncateToWidth,
    wrap: tui.wrapTextWithAnsi,
    visibleWidth: tui.visibleWidth,
    component: (build) => ({ render: build, invalidate: () => {} }),
    languageFromPath: coding.getLanguageFromPath,
    highlight(source, language, theme, owner) {
      if (!owner) return coding.highlightCode(source, language);
      // A grep output highlights one source per file group: an owner keeps them all. One render
      // highlights at most MAX_FORMAT_CHARS, so a miss that would pass it starts over: a block
      // whose output grows while it streams keeps only what it shows, after two renders at most.
      const palette = theme.colors;
      let cache = code.get(owner);
      const key = `${language}\n${source}`;
      const hit = cache && cache.palette === palette ? cache.rows.get(key) : undefined;
      if (hit) return hit;
      if (!cache || cache.palette !== palette || cache.chars + source.length > MAX_FORMAT_CHARS) {
        cache = { palette, chars: 0, rows: new Map() };
        code.set(owner, cache);
      }
      const rows = coding.highlightCode(source, language);
      cache.rows.set(key, rows);
      cache.chars += source.length;
      return rows;
    },
    markdown(source, width, theme, owner) {
      const palette = theme.colors;
      let cached = owner && markdown.get(owner);
      if (!cached || cached.palette !== palette) {
        cached = {
          source,
          palette,
          component: new tui.Markdown(source, 0, 0, coding.getMarkdownTheme(), {
            color: (text) => theme.fg("thinkingText", text),
            italic: true,
          }),
        };
        if (owner) markdown.set(owner, cached);
      } else if (cached.source !== source) {
        cached.source = source;
        cached.component.setText(source);
      }
      return cached.component.render(width);
    },
  };
}
