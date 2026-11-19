import type * as Coding from "@earendil-works/pi-coding-agent";
import type * as Tui from "@earendil-works/pi-tui";
import type { RenderKit, RenderTheme } from "./kit.ts";

/** Both the gallery and the extension supply their own resolved pi modules. */
export function createPiKit(
  tui: Pick<typeof Tui, "Markdown" | "truncateToWidth" | "visibleWidth" | "wrapTextWithAnsi">,
  coding: Pick<typeof Coding, "getLanguageFromPath" | "getMarkdownTheme" | "highlightCode">,
): RenderKit {
  type Palette = RenderTheme["colors"];
  const code = new WeakMap<object, { source: string; language: string; palette: Palette; rows: string[] }>();
  const markdown = new WeakMap<object, { source: string; palette: Palette; component: Tui.Markdown }>();
  return {
    truncateToWidth: tui.truncateToWidth,
    wrap: tui.wrapTextWithAnsi,
    visibleWidth: tui.visibleWidth,
    component: (build) => ({ render: build, invalidate: () => {} }),
    languageFromPath: coding.getLanguageFromPath,
    highlight(source, language, theme, owner) {
      const palette = theme.colors;
      const last = owner && code.get(owner);
      if (last && last.source === source && last.language === language && last.palette === palette) return last.rows;
      const rows = coding.highlightCode(source, language);
      if (owner) code.set(owner, { source, language, palette, rows });
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
