/** Render surface: the injected RenderKit, and components stacked into lines. */

import { createPiKit } from "../../packages/pi-prism/render/pi-kit.ts";
import type { RenderKit } from "../../packages/pi-prism/render/kit.ts";
import type { PiInstall } from "./pi.ts";

export function createKit(pi: PiInstall): RenderKit {
  return createPiKit(pi.modules.tui, pi.modules.coding);
}

/**
 * Concatenate rendered components into one transcript-like stack. `gap` inserts
 * that many blank rows between neighbours: blocks breathe, their bodies don't.
 */
export function stack(width: number, components: Array<{ render(width: number): string[] }>, gap = 0): string[] {
  const lines: string[] = [];
  components.forEach((component, index) => {
    if (index > 0) for (let row = 0; row < gap; row++) lines.push("");
    lines.push(...component.render(width));
  });
  return lines;
}
