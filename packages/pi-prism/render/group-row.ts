/**
 * Group row: what several collapsed tool rows become. One line, clickable.
 * Each segment reports its own failure count.
 */

import type { ComponentLike, RenderKit } from "./kit.ts";
import { formatDuration } from "./text.ts";
import type { RenderApi } from "./tool-row.ts";
import { groupVerb, toolTokenLabel, type TokenCounts, type GroupClass } from "./tools.ts";

export interface GroupSegment {
  cls: GroupClass;
  count: number;
  failed?: number;
}

export interface GroupRowInput {
  segments: GroupSegment[];
  expanded?: boolean;
  tokens?: TokenCounts;
  /** Elapsed wall time from the earliest member start to the latest member finish. */
  durationMs?: number;
}

export function renderGroupRow(api: RenderApi, input: GroupRowInput): ComponentLike {
  return api.kit.component((width) => {
    const { theme, glyphs, kit } = api;
    const marker = theme.fg("dim", input.expanded ? glyphs.expanded : glyphs.collapsed);
    const segments = input.segments.map((segment) => {
      const verb = groupVerb(segment.cls, segment.count);
      const label = theme.style(verb, { fg: "toolOutput", bold: true });
      const failures = segment.failed ?? 0;
      return failures
        ? label + " " + theme.fg("error", `(${failures} ${failures === 1 ? "failure" : "failures"})`)
        : label;
    });
    const dot = theme.fg("dim", ` ${glyphs.dot} `);
    const details: string[] = [];
    if (input.tokens) details.push(toolTokenLabel(input.tokens.outputTokens, input.tokens.inputTokens));
    if (input.durationMs !== undefined) details.push(formatDuration(input.durationMs));
    const suffix = details.map((part) => dot + theme.fg("dim", part)).join("");
    const title = `${marker} ${segments.join(dot)}`;
    const room = width - kit.visibleWidth(suffix);
    if (room >= 8 && suffix) {
      const left = kit.truncateToWidth(title, room, "…");
      return [left + " ".repeat(Math.max(0, room - kit.visibleWidth(left))) + suffix];
    }
    return [kit.truncateToWidth(title + suffix, width, "…")];
  });
}

/** Lay out a revealed member inside the summary, including its body and hover chip. */
export function renderGroupMember(kit: RenderKit, width: number, render: (innerWidth: number) => string[]): string[] {
  const indent = " ".repeat(Math.max(0, Math.min(2, width - 1)));
  const innerWidth = Math.max(1, width - indent.length);
  return render(innerWidth).map((line) =>
    line && width > 0 ? indent + kit.truncateToWidth(line, innerWidth, "…") : "",
  );
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
