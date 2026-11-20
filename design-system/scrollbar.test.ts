import { beforeAll, expect, test } from "bun:test";
import { barTokens } from "../packages/pi-ui/extensions/viewport.ts";
import { resolvePi, type PiInstall } from "./lib/pi.ts";
import { installTheme, loadThemeJson } from "./lib/theme.ts";

let pi: PiInstall;
beforeAll(async () => {
  pi = await resolvePi();
});

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** One sRGB channel, linearised. */
function linear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG contrast ratio of two colours. */
function contrast(first: Rgb, second: Rgb): number {
  const luminance = ({ r, g, b }: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const [light, dark] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

test("a hovered scroll bar keeps its thumb clear of its track, and differs from the bar at rest, in both themes", () => {
  for (const name of ["dark", "light"] as const) {
    const colors = installTheme(pi, loadThemeJson(pi, name)).theme.colors as Record<string, Rgb>;
    const color = (hovered: boolean, cell: "fill" | "track") => colors[barTokens(colors, hovered)[cell]]!;
    // The one-cell thumb must stand out on its track while the pointer is over the block.
    expect(contrast(color(true, "fill"), color(true, "track"))).toBeGreaterThan(3);
    expect(contrast(color(false, "fill"), color(false, "track"))).toBeGreaterThan(1.5);
    // Hovering changes both cells.
    expect(color(true, "fill")).not.toEqual(color(false, "fill"));
    expect(color(true, "track")).not.toEqual(color(false, "track"));
  }
});
