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

const failureLabel = (count: number) => `${count} ${count === 1 ? "failure" : "failures"}`;

/**
 * Fit order when the terminal is narrow: drop the duration, then the token
 * count (keeping the shorter duration if it still fits), and only then cut
 * segments. A cut summary trades its per-segment
 * failure counts for one right-aligned total, so failures are the last thing
 * to leave the row.
 */
export function renderGroupRow(api: RenderApi, input: GroupRowInput): ComponentLike {
  return api.kit.component((width) => {
    const { theme, glyphs, kit } = api;
    const marker = theme.fg("dim", input.expanded ? glyphs.expanded : glyphs.collapsed);
    const dot = theme.fg("dim", ` ${glyphs.dot} `);
    const title = (withFailures: boolean) =>
      `${marker} ${input.segments
        .map((segment) => {
          const label = theme.style(groupVerb(segment.cls, segment.count), { fg: "toolOutput", bold: true });
          const failures = segment.failed ?? 0;
          return withFailures && failures ? `${label} ${theme.fg("error", `(${failureLabel(failures)})`)}` : label;
        })
        .join(dot)}`;
    const alignRight = (left: string, right: string) =>
      left + " ".repeat(Math.max(0, width - kit.visibleWidth(left) - kit.visibleWidth(right))) + right;

    const tokens = input.tokens && toolTokenLabel(input.tokens.outputTokens, input.tokens.inputTokens);
    const duration = input.durationMs === undefined ? undefined : formatDuration(input.durationMs);
    const full = title(true);
    for (const metrics of [[tokens, duration], [tokens], [duration], []]) {
      const suffix = metrics
        .filter((part) => part !== undefined)
        .map((part) => dot + theme.fg("dim", part))
        .join("");
      if (kit.visibleWidth(full + suffix) <= width) return [alignRight(full, suffix)];
    }

    const failed = input.segments.reduce((sum, segment) => sum + (segment.failed ?? 0), 0);
    if (!failed) return [kit.truncateToWidth(full, width, "…")];
    const total = theme.fg("error", `${failed} failed`);
    const room = width - kit.visibleWidth(dot + total);
    if (room < 4) return [kit.truncateToWidth(`${marker} ${total}`, width, "…")];
    return [alignRight(kit.truncateToWidth(title(false), room, "…"), dot + total)];
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
