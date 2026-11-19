/**
 * Theme plumbing. pi's Theme class and the shipped dark/light JSON give the
 * fixtures the same palette the terminal uses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiInstall } from "./pi.ts";

export type ThemeName = "dark" | "light";

export interface ThemeJson {
  name?: string;
  appearance?: "dark" | "light";
  vars?: Record<string, string>;
  colors: Record<string, string>;
}

export interface InstalledTheme {
  name: ThemeName;
  json: ThemeJson;
  theme: any;
}

export function loadThemeJson(pi: PiInstall, name: ThemeName): ThemeJson {
  const path = join(pi.root, "dist", "modes", "interactive", "theme", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as ThemeJson;
}

/** Resolve `vars` references (which may themselves reference vars). */
function resolveVars(json: ThemeJson): Record<string, string> {
  const vars = json.vars ?? {};
  const resolved: Record<string, string> = {};
  const resolve = (key: string, depth = 0): string => {
    if (depth > 10) return "";
    const cached = resolved[key];
    if (cached) return cached;
    const value = vars[key] ?? key;
    const next = vars[value] !== undefined ? resolve(value, depth + 1) : value;
    resolved[key] = next;
    return next;
  };
  for (const key of Object.keys(vars)) resolve(key);
  return resolved;
}

const BG_TOKEN = /Bg$|^border$|^borderAccent$|^borderMuted$/;

export function installTheme(pi: PiInstall, json: ThemeJson): InstalledTheme {
  const vars = resolveVars(json);
  const resolve = (value: string): string => vars[value] ?? value;

  const fg: Record<string, string> = {};
  const bg: Record<string, string> = {};
  for (const [key, value] of Object.entries(json.colors)) {
    const concrete = resolve(value);
    fg[key] = concrete;
    if (BG_TOKEN.test(key)) bg[key] = concrete;
  }

  pi.modules.theme.initTheme(json.name ?? "dark");
  const theme = new pi.modules.theme.Theme(fg, bg, "truecolor");
  pi.modules.theme.setThemeInstance(theme);

  return {
    name: (json.name as ThemeName) ?? "dark",
    json,
    theme,
  };
}
