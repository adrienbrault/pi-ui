/**
 * Group row: what several collapsed tool rows become. One line, clickable.
 * Failures are never hidden inside a group; the segment keeps its own count.
 */

import type { ComponentLike } from "./kit.ts";
import type { RenderApi } from "./tool-row.ts";
import { groupVerb, type GroupClass } from "./tools.ts";

export interface GroupSegment {
  cls: GroupClass;
  count: number;
  failed?: number;
}

export interface GroupRowInput {
  segments: GroupSegment[];
  expanded?: boolean;
  /** Wall time the folded rows spent, summed: one number for the whole group. */
  durationMs?: number;
}

export function renderGroupRow(api: RenderApi, input: GroupRowInput): ComponentLike {
  return api.kit.component((width) => {
    const { theme, glyphs, kit } = api;
    const marker = theme.fg("dim", input.expanded ? glyphs.expanded : glyphs.collapsed);
    const segments = input.segments.map((segment) => {
      const verb = groupVerb(segment.cls, segment.count);
      return theme.style(verb, { fg: "toolOutput", bold: true });
    });
    if (input.segments.some((segment) => (segment.failed ?? 0) > 0)) {
      const failed = input.segments.reduce((sum, segment) => sum + (segment.failed ?? 0), 0);
      segments.push(theme.fg("error", `${failed} failed`));
    }
    const dot = theme.fg("dim", ` ${glyphs.dot} `);
    let line = `${marker} ${segments.join(dot)}`;
    if (input.durationMs !== undefined) {
      const seconds = input.durationMs / 1000;
      const label = seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
      line += `${dot}${theme.fg("dim", label)}`;
    }
    return [kit.truncateToWidth(line, width, "…")];
  });
}

export function groupSegments(rows: Array<{ cls: GroupClass; failed?: boolean }>): GroupSegment[] {
  const byClass = new Map<GroupClass, GroupSegment>();
  for (const row of rows) {
    const existing = byClass.get(row.cls);
    if (existing) {
      existing.count += 1;
      if (row.failed) existing.failed = (existing.failed ?? 0) + 1;
    } else {
      byClass.set(row.cls, { cls: row.cls, count: 1, ...(row.failed ? { failed: 1 } : {}) });
    }
  }
  return [...byClass.values()];
}
