// pi styles bold and italic through chalk; force colour even when piped.
process.env.FORCE_COLOR ||= "3";

/**
 * `bun run ds:show [filter] [--width N] [--theme dark|light] [--ascii]`
 *
 * Print registry cards to the terminal as raw ANSI, rendered the same way the
 * fixtures are. The filter is a substring of the entry id. A multi-frame state
 * prints its last frame.
 */

import { ENTRIES, THEME_NAMES, type RenderCtx } from "./registry.ts";
import { resolvePi } from "./lib/pi.ts";
import { createKit } from "./lib/surface.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";
import { glyphsFor, type GlyphMode } from "../packages/pi-prism/render/glyphs.ts";

type ThemeName = (typeof THEME_NAMES)[number];

interface Options {
  filter: string;
  width: number;
  themeName: ThemeName;
  glyphMode: GlyphMode;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    filter: "",
    width: process.stdout.columns || 100,
    themeName: "dark",
    glyphMode: "unicode",
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--ascii") options.glyphMode = "ascii";
    else if (arg === "--width") {
      const width = Number(argv[++index]);
      if (!Number.isInteger(width) || width < 1) throw new Error("--width expects a positive integer");
      options.width = width;
    } else if (arg === "--theme") {
      const name = argv[++index] ?? "";
      if (!THEME_NAMES.includes(name as ThemeName)) throw new Error(`--theme expects ${THEME_NAMES.join(" or ")}`);
      options.themeName = name as ThemeName;
    } else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else options.filter = arg;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const entries = ENTRIES.filter((entry) => entry.id.includes(options.filter));
  if (entries.length === 0) {
    console.error(`no entry id contains "${options.filter}"`);
    process.exitCode = 1;
    return;
  }

  const pi = await resolvePi();
  const { theme } = installTheme(pi, loadThemeJson(pi, options.themeName));
  const ctx: RenderCtx = {
    pi,
    kit: createKit(pi),
    theme,
    glyphs: glyphsFor(options.glyphMode),
    glyphMode: options.glyphMode,
    width: options.width,
    themeName: options.themeName,
  };

  const cards: string[] = [];
  for (const entry of entries) {
    for (const state of entry.states) {
      const lines = state.render(ctx, (state.frames ?? 1) - 1);
      cards.push([theme.fg("dim", `${entry.id} · ${state.id}`), ...lines].join("\n"));
    }
  }
  // Await the write: the explicit exit below would otherwise cut a piped stream short.
  await Bun.write(Bun.stdout, cards.join("\n\n") + "\n");
}

// pi's imported modules leave handles open; exit explicitly so the script finishes.
main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
