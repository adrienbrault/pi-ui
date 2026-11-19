/**
 * Group row: what several collapsed tool rows become. One line, clickable.
 * Each segment reports its own failure count.
 */

import { cutMark, type ComponentLike, type RenderKit } from "./kit.ts";
import { formatDuration } from "./text.ts";
import type { RenderApi } from "./tool-row.ts";
import { groupVerb, toolTokenLabel, type TokenCounts, type GroupClass } from "./tools.ts";

export interface GroupSegment {
  cls: GroupClass;
  count: number;
  failed?: number;
  /** Summed active time of the members; absent unless every member was timed. */
  durationMs?: number;
}

export interface GroupRowInput {
  segments: GroupSegment[];
  expanded?: boolean;
  tokens?: TokenCounts;
  /** Elapsed wall time from the earliest member start to the latest member finish. */
  durationMs?: number;
}

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
    const mark = cutMark(theme);
    const marker = theme.fg("dim", input.expanded ? glyphs.expanded : glyphs.collapsed);
    const dot = theme.fg("dim", ` ${glyphs.dot} `);
    const comma = theme.fg("dim", ", ");
    // One sentence: `Thought for 3m 40s, listed 3 directories, ran 2 shell commands for 9.1s (1 failed)`.
    const title = (withFailures: boolean) =>
      `${marker} ${input.segments
        .map((segment, index) => {
          const phrase = groupVerb(segment.cls, segment.count, segment.durationMs);
          const text = index === 0 ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
          const label = theme.style(text, { fg: "toolOutput", bold: true });
          const failures = segment.failed ?? 0;
          return withFailures && failures ? `${label} ${theme.fg("error", `(${failures} failed)`)}` : label;
        })
        .join(comma)}`;
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
    if (!failed) return [kit.truncateToWidth(full, width, mark)];
    const total = theme.fg("error", `${failed} failed`);
    const room = width - kit.visibleWidth(dot + total);
    if (room < 4) return [kit.truncateToWidth(`${marker} ${total}`, width, mark)];
    return [alignRight(kit.truncateToWidth(title(false), room, mark), dot + total)];
  });
}

/** Lay out a revealed member inside the summary, including its body. `mark` ends a row that still overflows. */
export function renderGroupMember(
  kit: RenderKit,
  width: number,
  render: (innerWidth: number) => string[],
  mark: string,
): string[] {
  const indent = " ".repeat(Math.max(0, Math.min(2, width - 1)));
  const innerWidth = Math.max(1, width - indent.length);
  return render(innerWidth).map((line) =>
    line && width > 0 ? indent + kit.truncateToWidth(line, innerWidth, mark) : "",
  );
}

/** Merge rows by class in encounter order. A row may stand for several members (a message's thinking runs). */
export function groupSegments(
  rows: Array<{ cls: GroupClass; count?: number; failed?: boolean; durationMs?: number }>,
): GroupSegment[] {
  const byClass = new Map<GroupClass, GroupSegment & { untimed?: boolean }>();
  for (const row of rows) {
    const segment = byClass.get(row.cls) ?? { cls: row.cls, count: 0 };
    byClass.set(row.cls, segment);
    segment.count += row.count ?? 1;
    if (row.failed) segment.failed = (segment.failed ?? 0) + 1;
    if (row.durationMs === undefined) segment.untimed = true;
    else segment.durationMs = (segment.durationMs ?? 0) + row.durationMs;
  }
  return [...byClass.values()].map(({ untimed, durationMs, ...segment }) =>
    untimed || durationMs === undefined ? segment : { ...segment, durationMs },
  );
}
