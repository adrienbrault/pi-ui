/**
 * A compaction, or a branch summary: pi's own two summary blocks. pi draws each as a band
 * on `customMessageBg` under a bold `[compaction]` (or `[branch]`), with the summary itself
 * behind an expand key. pi-ui draws it as a block in the transcript's vocabulary: a
 * collapsed/expanded glyph, the label, the one number pi records for it, and the summary's
 * opening rows under it, in Markdown as pi renders the summary. A click opens the rest.
 *
 * Not on the detail ladder: a summary is a boundary in the transcript, not a block in the
 * run that decays, so it reads the same at any distance.
 */

import { blockBodyIndent, cutMark, omissionStyle, type RenderKit, type RenderTheme } from "./kit.ts";
import type { GlyphSet } from "./glyphs.ts";
import { cleanOutput, MAX_FORMAT_CHARS, omittedLinesLabel } from "./text.ts";
import { formatRate, HEADER_MARGIN } from "./tools.ts";

/** The two roles pi hands the transcript as a summary. */
export type SummaryKind = "compaction" | "branch";

/** What each kind of summary is called, as a tool row leads with its verb. */
export const SUMMARY_LABELS: Record<SummaryKind, string> = {
  compaction: "compaction",
  branch: "branch",
};

/** The rows a closed summary keeps of its own text, before the count of what it hides. */
export const SUMMARY_CLOSED_ROWS = 2;

export interface SummaryApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
  /** Keeps a summary's parsed Markdown across renders. */
  owner?: object;
}

export interface SummaryInput {
  kind: SummaryKind;
  /** The summary Markdown, as pi wrote it. */
  summary: string;
  /** The context's size before a compaction: the one number pi records for it. */
  tokensBefore?: number;
  expanded?: boolean;
  /** The pointer is over the block: its number and its notice light up. */
  lit?: boolean;
  width: number;
}

export interface SummaryLayout {
  /** The header row, then the body rows: no padding, the transcript spaces blocks itself. */
  rows: string[];
  /** Whether a click changes anything: only a summary with rows to reveal opens. */
  canToggle: boolean;
}

/** `▸ compaction · 128.4k tokens`, or `▾` once open. A hovered number turns the text colour. */
export function summaryHeader(api: SummaryApi, input: SummaryInput): string {
  const { kit, theme, glyphs } = api;
  const edge = Math.max(1, input.width - HEADER_MARGIN);
  // The glyph keeps the accent at any hover, like a tool row's marker.
  const mark = theme.fg("accent", input.expanded ? glyphs.expanded : glyphs.collapsed);
  const label = theme.style(SUMMARY_LABELS[input.kind], { fg: "toolTitle", bold: true });
  const head = `${mark} ${label}`;
  // A compaction's number is the context it replaced. A branch summary carries none: pi's
  // context message keeps only the text, and its count lives on the session entry.
  const metric = input.tokensBefore === undefined ? "" : `${formatRate(input.tokensBefore)} tokens`;
  if (!metric) return kit.truncateToWidth(head, edge, cutMark(theme));
  return kit.truncateToWidth(
    `${head} ${theme.fg("dim", glyphs.dot)} ${theme.fg(input.lit ? "text" : "accent", metric)}`,
    edge,
    cutMark(theme),
  );
}

/** The summary's rows: Markdown when the kit parses it, wrapped lines when it does not. */
function summaryRows(api: SummaryApi, input: SummaryInput, bodyWidth: number): string[] {
  const { kit, theme } = api;
  const text = cleanOutput(input.summary).trimEnd();
  if (!text) return [];
  if (kit.markdown && text.length <= MAX_FORMAT_CHARS) {
    return kit
      .markdown(text, bodyWidth, theme, api.owner, { token: "text", italic: false })
      .map((row) => row.trimEnd());
  }
  return text.split("\n").flatMap((line) => (line.trim() ? kit.wrap(line, bodyWidth) : []));
}

/** The header and the body a summary shows: its opening rows closed, all of it open. */
export function summaryLayout(api: SummaryApi, input: SummaryInput): SummaryLayout {
  const { kit, theme, glyphs } = api;
  const indent = blockBodyIndent(input.width);
  const bodyWidth = Math.max(1, input.width - HEADER_MARGIN - indent.length);
  const rows = summaryRows(api, input, bodyWidth);
  // Closed, a blank row carries no evidence and takes no row (an opened summary keeps its layout).
  const dense = rows.filter((row) => row.trim());
  const canToggle = dense.length > SUMMARY_CLOSED_ROWS;
  // Nothing lights on a block a click cannot open.
  const lit = input.lit && canToggle;
  if (!rows.length) return { rows: [summaryHeader(api, { ...input, lit })], canToggle: false };
  const kept = input.expanded ? rows : dense.slice(0, SUMMARY_CLOSED_ROWS);
  const hidden = dense.length - kept.length;
  const body = kept.map((row) => indent + kit.truncateToWidth(row, bodyWidth, cutMark(theme)));
  // The notice counts against the block's own rows: opening it shows what it promises.
  if (!input.expanded && hidden > 0)
    body.push(
      indent + kit.truncateToWidth(omissionStyle(theme, omittedLinesLabel(hidden, "between", glyphs), lit), bodyWidth),
    );
  return { rows: [summaryHeader(api, { ...input, lit }), ...body], canToggle };
}

/** A summary as a component the design system can render like any card. */
export function renderSummary(api: SummaryApi, input: SummaryInput): string[] {
  return summaryLayout(api, input).rows;
}
