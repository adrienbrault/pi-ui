/**
 * Tool row: one header line plus a bounded body. The body budget is the whole
 * point: the closer a row is to the tail, the more of its output survives.
 */

import { bodyLinesFor, COMPACT_LEVEL, MAX_FULL_LINES, type DetailLevel } from "./detail.ts";
import { frameAt, UNICODE_GLYPHS, type GlyphSet, type TokenMarks } from "./glyphs.ts";
import {
  cellPadding,
  metricColumns,
  MIN_DESCRIPTION,
  tableFits,
  type ColumnLabels,
  type MemberCells,
  type MemberColumns,
} from "./columns.ts";
import {
  blockBodyIndent,
  cutMark,
  omissionStyle,
  type ComponentLike,
  type RenderKit,
  type RenderTheme,
} from "./kit.ts";
import {
  cleanOutput,
  formatDuration,
  logicalLines,
  nonEmptyLineCount,
  oneLine,
  omittedLinesLabel,
  MAX_FORMAT_CHARS,
  type OmissionSide,
} from "./text.ts";
import { highlightShellLines, shellView, type ShellLine, type ShellView } from "./shell-output.ts";
import {
  describeCall,
  formatRate,
  HEADER_MARGIN,
  outputRateFor,
  toolTokenCounts,
  toolMeta,
  toolTokenLabel,
  sessionCommand,
  type SessionPlace,
  type TokenRates,
} from "./tools.ts";

export interface RenderApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
  owner?: object;
}

export type ToolStatus = "pending" | "running" | "success" | "error";

export interface ToolRowInput extends TokenRates, SessionPlace {
  name: string;
  args?: Record<string, unknown>;
  status: ToolStatus;
  level: DetailLevel;
  expanded?: boolean;
  /** The pointer is over a block that can open or close: its omission notices light up. */
  lit?: boolean;
  /** Read the whole body: no budget, no "more lines" cue. */
  full?: boolean;
  /** Override the derived path/command/query. */
  title?: string;
  /** Override the derived count, e.g. "42 lines" or "+8/−2". */
  summary?: string;
  output?: string;
  error?: string;
  outputTokens?: number;
  inputTokens?: number;
  durationMs?: number;
  frame?: number;
  /** As an open group's member: the group's column widths, so its rows line up. */
  columns?: MemberColumns;
  /** The column words this member row writes (`columnLabelRows`); every word when absent. */
  columnLabels?: ColumnLabels;
  /** Files a shell command created, changed or deleted in its git work tree, shown after its output. */
  changes?: FileChanges;
}

/** A file a shell command changed, as the extension recorded it on the tool result. */
export interface FileChange {
  /** Relative to the session's working directory. */
  path: string;
  kind: "created" | "modified" | "deleted";
  /** A unified patch from the file before the command to after it; absent when there is none to show. */
  patch?: string;
  /** Why a created or modified file has no patch. */
  note?: "binary" | "too large";
}

export interface FileChanges {
  files: FileChange[];
  /** Changed files beyond the recorded list. */
  more?: number;
}

/** The verb a tool row leads with: `bash`, `read`, an MCP `server/tool`. */
export function toolLabel(name: string): string {
  return oneLine(toolMeta(name).label);
}

function statusGlyph(api: RenderApi, input: ToolRowInput): string {
  const { theme, glyphs } = api;
  switch (input.status) {
    case "pending":
      return theme.fg("dim", glyphs.pending);
    case "running":
      return theme.fg("accent", frameAt(glyphs, input.frame ?? 0) || glyphs.pending);
    case "success":
      return theme.fg("success", glyphs.success);
    case "error":
      return theme.fg("error", glyphs.error);
  }
}

/**
 * Keep the opening and the end: a shell command's verb and target both matter.
 * Each kept side is painted on its own, so the mark's style never leaks into it.
 */
export function truncateMiddle(
  kit: RenderKit,
  text: string,
  width: number,
  mark: string,
  paint: (part: string) => string,
): { text: string; cut: boolean } {
  if (width <= 0) return { text: "", cut: text.length > 0 };
  if (kit.visibleWidth(text) <= width) return { text: paint(text), cut: false };
  const room = width - kit.visibleWidth(mark);
  if (room <= 0) return { text: kit.truncateToWidth(mark, width, ""), cut: true };
  // Columns, not characters: a wide character takes two, and a cluster is never split.
  const parts = graphemes(text);
  const head = fitColumns(kit, parts, Math.ceil(room / 2));
  const tail = fitColumns(kit, parts.slice(head.count).toReversed(), room - head.width);
  const end = parts.slice(parts.length - tail.count).join("");
  return {
    text: `${paint(parts.slice(0, head.count).join(""))}${mark}${end ? paint(end) : ""}`,
    cut: true,
  };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A string's grapheme clusters: what a terminal draws as one character. */
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/** How many leading parts fit in `room` columns, and the columns they take. */
function fitColumns(kit: RenderKit, parts: string[], room: number): { count: number; width: number } {
  let width = 0;
  let count = 0;
  for (const part of parts) {
    const next = width + kit.visibleWidth(part);
    if (next > room) break;
    width = next;
    count += 1;
  }
  return { count, width };
}

/** Keep the end of a long path: the basename is the part a reader needs. */
function truncateLeft(
  kit: RenderKit,
  text: string,
  width: number,
  mark: string,
  paint: (part: string) => string,
): { text: string; cut: boolean } {
  if (width <= 0) return { text: "", cut: text.length > 0 };
  if (kit.visibleWidth(text) <= width) return { text: paint(text), cut: false };
  const chars = [...text];
  let kept = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const candidate = (chars[i] ?? "") + kept;
    if (kit.visibleWidth(candidate) + kit.visibleWidth(mark) > width) break;
    kept = candidate;
  }
  return { text: kept ? `${mark}${paint(kept)}` : kit.truncateToWidth(paint(text), width, mark), cut: true };
}

/**
 * Split a line at `width` columns: the largest prefix that fits, broken after
 * its last space when it has one, and the rest without its leading spaces.
 * With `slashes`, a path breaks after its last `/` that fits when that comes later.
 */
function splitAt(kit: RenderKit, line: string, width: number, slashes = false): [string, string] {
  if (kit.visibleWidth(line) <= width) return [line, ""];
  const chars = [...line];
  let end = 0;
  let used = 0;
  while (end < chars.length) {
    const next = kit.visibleWidth(chars[end]!);
    if (used + next > width) break;
    used += next;
    end++;
  }
  const space = chars.slice(0, end + 1).lastIndexOf(" ");
  // Break after the slash, so each row of a path ends with a directory's `/`.
  const slash = slashes ? chars.slice(0, end).lastIndexOf("/") + 1 : 0;
  const cut = slash > Math.max(0, space) ? slash : space > 0 ? space : Math.max(1, end);
  return [chars.slice(0, cut).join("").trimEnd(), chars.slice(cut).join("").trimStart()];
}

/** A line broken into rows of at most `width` columns, at spaces and, with `slashes`, after `/`. */
function breakRows(kit: RenderKit, line: string, width: number, slashes: boolean): string[] {
  const rows: string[] = [];
  let rest = line;
  // No line can need more rows than the whole cap: bound the work.
  while (rest && rows.length <= MAX_FULL_LINES) {
    const [head, tail] = splitAt(kit, rest, width, slashes);
    rows.push(head);
    rest = tail;
  }
  return rows;
}

type HeaderPiece = { kind: "title" | "summary" | "tokens" | "error" | "duration"; text: string };

/**
 * A failed shell ends with the exit status; stderr sits above it. The header
 * carries the status, the body carries the evidence (never the other way round).
 */
function errorLines(input: ToolRowInput): string[] {
  return logicalLines(cleanOutput(input.error ?? "")).filter((line) => line.trim() !== "");
}

function errorHeadline(input: ToolRowInput, meta: ReturnType<typeof toolMeta>): string | undefined {
  if (input.status !== "error" || !input.error) return undefined;
  const line = meta.cls === "shell" ? errorLines(input).at(-1) : errorLines(input)[0];
  return line === undefined ? undefined : oneLine(line);
}

function errorDetail(input: ToolRowInput, meta: ReturnType<typeof toolMeta>): string {
  if (!input.error) return "";
  if (meta.cls !== "shell") return input.error;
  const lines = errorLines(input);
  return lines.slice(0, -1).join("\n");
}

/** Numbers in the text colour, `out` and `in` as keyword and type, units and separators muted. */
/**
 * A header row: `left` at the start, `right` against the edge. The separator
 * stands between them only when they meet; with room between, spaces part them
 * and no dot hangs at the end of the description.
 */
export function alignEnds(kit: RenderKit, left: string, right: string, sep: string, width: number): string {
  const gap = width - kit.visibleWidth(left) - kit.visibleWidth(right);
  if (gap <= kit.visibleWidth(sep)) return left + sep + right;
  return left + " ".repeat(gap) + right;
}

/** Text matched literally inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** Metrics in colour: numbers in text, the output mark in the keyword colour, the input mark in the type colour. */
export function styleMetric(theme: RenderTheme, label: string, marks: TokenMarks = UNICODE_GLYPHS): string {
  const output = marks.output.trim();
  const input = marks.input.trim();
  const symbols = [output, input].filter((mark) => !/^[a-z]+$/i.test(mark)).map(escapeRegExp);
  const parts = new RegExp(
    `\\d+(?:\\.\\d+)?k?|[a-z]+${symbols.length ? `|${symbols.join("|")}` : ""}|[^a-z\\d${symbols.join("")}]+`,
    "giu",
  );
  return (label.match(parts) ?? [])
    .map((part) => {
      if (/^\d/.test(part)) return theme.fg("text", part);
      if (part === output) return theme.fg("syntaxKeyword", part);
      if (part === input) return theme.fg("syntaxType", part);
      return theme.fg("muted", part);
    })
    .join("");
}

/** A tool row's cells in its group's table: its call is model output, its result model input. */
export function toolRowCells(input: ToolRowInput): MemberCells {
  const { outputTokens, inputTokens } = toolTokenCounts(input);
  return {
    label: toolLabel(input.name),
    outValue: formatRate(outputTokens),
    ...(outputRateFor(outputTokens, input.outputRate) ? { outRate: formatRate(input.outputRate!) } : {}),
    inValue: formatRate(inputTokens),
    ...(input.inputRate ? { inRate: `${input.inputRateEstimated ? "~" : ""}${formatRate(input.inputRate)}` } : {}),
    ...(input.durationMs !== undefined ? { duration: formatDuration(input.durationMs) } : {}),
  };
}

export function toolHeader(api: RenderApi, input: ToolRowInput, rowWidth: number) {
  const { theme, glyphs, kit } = api;
  // The header, and an opened title's rows under it, stop short of the scroll bar's column.
  const width = Math.max(1, rowWidth - HEADER_MARGIN);
  const meta = toolMeta(input.name);
  // Names, titles, summaries and errors come from the model or the tool: never trust them.
  const label = toolLabel(input.name);
  const title = oneLine(input.title ?? describeCall(input.name, input.args, input).title);
  const summary = input.summary === undefined ? undefined : oneLine(input.summary);
  const { outputTokens, inputTokens } = toolTokenCounts(input);
  const tokens = toolTokenLabel(outputTokens, inputTokens, input, glyphs);

  const sep = ` ${theme.fg("dim", glyphs.dot)} `;
  const mark = cutMark(theme);
  // The verb is the headline: bold it through `style` so it survives headless
  // rendering, where chalk's bold turns itself off without a terminal.
  // As a group member, the label fills its column so every member's description starts together.
  const labelPad = input.columns ? cellPadding(label, input.columns.label, kit.visibleWidth) : "";
  const prefix = `${statusGlyph(api, input)} ${theme.style(label, { fg: "toolTitle", bold: true })}${labelPad}`;

  let pieces: HeaderPiece[] = [];
  // MCP labels already read `server/tool`; repeating it as the title is noise.
  if (title && title !== label) pieces.push({ kind: "title", text: theme.fg("accent", title) });
  if (summary) pieces.push({ kind: "summary", text: theme.fg("dim", summary) });
  // As a group member, tokens, rates and duration fill the group's columns as one piece, or,
  // when the group's rows are too narrow for the table, leave the row to its description.
  if (!input.columns) pieces.push({ kind: "tokens", text: styleMetric(theme, tokens, glyphs) });
  else if (tableFits(input.columns, width, glyphs))
    // Right-aligned, the cells keep their columns without the spaces a left-out word leaves at the
    // start: trimmed, they stand apart from the description by spaces rather than meet it.
    pieces.push({
      kind: "tokens",
      text: styleMetric(
        theme,
        metricColumns(toolRowCells(input), input.columns, input.columnLabels, glyphs).trimStart(),
        glyphs,
      ),
    });
  const error = errorHeadline(input, meta);
  if (error) pieces.push({ kind: "error", text: theme.fg("error", error) });
  const duration =
    input.durationMs === undefined || input.columns ? undefined : styleMetric(theme, formatDuration(input.durationMs));
  if (duration) pieces.push({ kind: "duration", text: duration });

  const compose = (parts: HeaderPiece[]) => parts.reduce((acc, part) => `${acc}${sep}${part.text}`, prefix);

  // Reserve space for the running shell clock if even a shortened command fits beside it.
  const keepClock = duration && kit.visibleWidth(prefix + sep + mark + sep + duration) <= width;
  // The command or path keeps a readable share of the row, at least 20 columns or 40% of it,
  // before any metric: the metrics shrink first, then leave.
  // An open group's member keeps the table's own floor, so every member row agrees with `tableFits`.
  const titleFloor = input.columns ? MIN_DESCRIPTION : Math.max(20, Math.floor(width * 0.4));
  const minimumWidth = (parts: HeaderPiece[]) =>
    kit.visibleWidth(
      compose(
        parts.map((piece) =>
          piece.kind === "title" ? { ...piece, text: kit.truncateToWidth(title, titleFloor, mark) } : piece,
        ),
      ),
    );
  const required = () => pieces.filter((piece) => piece.kind !== "summary" && (piece.kind !== "duration" || keepClock));
  const tokenPiece = pieces.find((piece) => piece.kind === "tokens");
  if (tokenPiece && !input.columns) {
    // Narrower and narrower: without the rates, then the output count alone.
    const variants = [
      tokens,
      toolTokenLabel(outputTokens, inputTokens, undefined, glyphs),
      `${glyphs.output}${formatRate(outputTokens)}`,
    ];
    const fitting = variants.find((variant) => {
      tokenPiece.text = styleMetric(theme, variant, glyphs);
      return minimumWidth(required()) <= width;
    });
    if (!fitting) pieces = pieces.filter((piece) => piece !== tokenPiece);
  } else if (minimumWidth(required()) > width) pieces = pieces.filter((piece) => piece.kind !== "tokens");
  const optional = keepClock ? ["summary"] : ["duration", "summary"];
  for (const kind of optional) {
    if (minimumWidth(pieces) <= width) break;
    pieces = pieces.filter((piece) => piece.kind !== kind);
  }

  const titlePiece = pieces.find((piece) => piece.kind === "title");
  const others = pieces.filter((piece) => piece !== titlePiece);
  const room = width - kit.visibleWidth(compose(others)) - kit.visibleWidth(sep);
  // Whether a closed header cuts the title; an opened one reports the same, so the row stays openable.
  const truncated = !!titlePiece && kit.visibleWidth(compose(pieces)) > width;
  const shell = meta.cls === "shell";
  const command = shell ? cleanOutput(sessionCommand(String(input.args?.command ?? title), input)) : "";
  /**
   * What a closed header does not show of its title: a shell command it cut or folded onto one
   * line, or any other title too wide for the row (a path, a pattern, a query, an MCP argument).
   */
  const hiddenTitle = shell
    ? command && (truncated || command !== title)
      ? command
      : undefined
    : truncated
      ? title
      : undefined;
  // Hovering a block that can open or close lights its clipped title, foreground only: the cut mark stays.
  const tone = input.lit ? "text" : "accent";
  /** Opened: the title's rows after the header, each starting in `column`. */
  let continuation: { column: number; rows: string[] } | undefined;
  if (titlePiece && hiddenTitle && (input.expanded || input.full)) {
    // Opened: the header carries the title's first segment, and the rest continues on the
    // following rows in the column where the title starts. A path breaks after a `/`.
    const column = kit.visibleWidth(prefix + sep);
    const [first = "", ...lines] = hiddenTitle.split("\n");
    const [head, rest] = splitAt(kit, first, Math.max(1, room), !shell);
    titlePiece.text = theme.fg(tone, head);
    const inner = Math.max(1, width - column);
    continuation = {
      column,
      rows: (rest ? [rest, ...lines] : lines).flatMap((line) =>
        (shell
          ? // No line can need more rows than the whole cap: bound the wrap work.
            kit.wrap(kit.truncateToWidth(line, inner * (MAX_FULL_LINES + 1), ""), inner)
          : breakRows(kit, line, inner, true)
        ).map((part) => " ".repeat(column) + theme.fg(tone, part)),
      ),
    };
  } else if (titlePiece && truncated) {
    const truncate = shell ? truncateMiddle : truncateLeft;
    titlePiece.text = truncate(kit, title, room, mark, (part) => theme.fg(tone, part)).text;
  }

  const metrics = pieces.filter((part) => part.kind === "tokens" || part.kind === "duration");
  if (!metrics.length) return { line: kit.truncateToWidth(compose(pieces), width, mark), hiddenTitle, continuation };
  const left = compose(pieces.filter((part) => !metrics.includes(part)));
  const right = metrics.map((part) => part.text).join(sep);
  const line = kit.truncateToWidth(alignEnds(kit, left, right, sep, width), width, mark);
  return { line, hiddenTitle, continuation };
}

interface Selected {
  line: string;
  /** A notice row rather than a body row: how many lines it hides, and on which side. */
  notice?: { count: number; side: OmissionSide };
  styled?: string;
  /** Position among the body's non-empty source lines. */
  index?: number;
  /** The line's number in its file, shown in the gutter. */
  number?: number;
  /** The file a grep line came from: a path row heads each run of its lines. */
  path?: string;
  /** On a changed file's path row: what the command did to it, and the lines its diff adds and removes. */
  change?: { kind: FileChange["kind"]; added: number; removed: number };
  /**
   * A row that is neither output nor a notice: grep's or a diff's divider, a path row, or a note
   * on a changed file that has no diff to show (its words are in `line`).
   */
  rule?: "divider" | "path" | "note";
  /** A diff row's colour, read from its place in the patch: additions green, removals red. */
  tone?: "success" | "error" | "accent" | "dim";
  /** An edit-style change row: its tone is a background, the full width of the code column. */
  bg?: boolean;
  /** Unchanged context or patch metadata: the first rows a diff preview drops. */
  context?: boolean;
}

/** One cell of a block's scroll bar, drawn in column 1. */
export type BarCell = "fill" | "track";

/**
 * What a preview hides, one cell per preview row: each cell stands for an equal
 * share of the source lines and is filled when the preview shows none of them,
 * so the filled cells are what a click would reveal. A read cut in the middle
 * fills the middle; a log tail fills everything above its last cell.
 */
export function previewBar(total: number, shown: ReadonlySet<number>, rows: number): BarCell[] {
  return Array.from({ length: rows }, (_, row): BarCell => {
    const from = Math.floor((row * total) / rows);
    const to = Math.max(from + 1, Math.floor(((row + 1) * total) / rows));
    for (let index = from; index < to; index++) if (shown.has(index) || index >= total) return "track";
    return "fill";
  });
}

/**
 * Between two numbered rows a notice counts the numbers it skips, blank lines
 * included, so it agrees with the jump the reader sees in the gutter.
 */
function spanCount(selected: Selected[], index: number): Selected {
  const item = selected[index]!;
  const before = selected[index - 1]?.number;
  const after = selected[index + 1]?.number;
  if (!item.notice || before === undefined || after === undefined || after <= before) return item;
  return { ...item, notice: { ...item.notice, count: after - before - 1 } };
}

const notice = (count: number, side: OmissionSide): Selected => ({ line: "", notice: { count, side } });

/**
 * Diffs keep what changed. Before hiding any hunk, drop the unchanged context
 * lines: the +/- rows carry the evidence, context is what a reader can infer.
 */
function selectDiff(lines: Selected[], show: number): Selected[] {
  if (lines.length <= show) return lines;
  if (show <= 0) return [];

  const essential = lines.filter((row) => !row.context);
  const contextHidden = lines.length - essential.length;
  if (essential.length + 1 <= show) {
    // The dropped context sat between the changes kept in order.
    return tidyDividers([...essential, notice(contextHidden, "between")]);
  }

  // Still too long: read the evidence in order, and say how much is left below it.
  const kept = essential.slice(0, show - 1);
  return tidyDividers([...kept, notice(lineCount(lines) - lineCount(kept), "below")]);
}

/** Lines among rows: a divider or a path row stands for no line. */
const lineCount = (rows: Selected[]): number => rows.filter((row) => !row.rule).length;

/** Each line's position among the body's lines, for the bar and the fade; rules have none. */
function indexLines(rows: Selected[]): Selected[] {
  let index = 0;
  return rows.map((row) => (row.rule ? row : { ...row, index: index++ }));
}

/**
 * A divider marks a jump between two kept hunks of one file: never the first or last row, never
 * beside a notice (which already says lines are missing there) or a path row, never twice in a row.
 */
function tidyDividers(rows: Selected[]): Selected[] {
  const gap = (row: Selected | undefined) => !row || !!row.notice || !!row.rule;
  const kept: Selected[] = [];
  rows.forEach((row, index) => {
    if (row.rule === "divider" && (gap(kept.at(-1)) || gap(rows[index + 1]))) return;
    kept.push(row);
  });
  return kept;
}

/** Reads keep their opening and their end; the notice marks the cut between them. */
function selectHead(lines: Selected[], show: number): Selected[] {
  if (lines.length <= show) return lines;
  const room = show - 1;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  const hidden = lines.length - head - tail;
  // `slice(-0)` is `slice(0)`: a zero tail would spill the whole file.
  const keptTail = tail > 0 ? lines.slice(-tail) : [];
  return [...lines.slice(0, head), notice(hidden, tail > 0 && head > 0 ? "between" : "below"), ...keptTail];
}

/** Logs keep the end: the last line is the one that explains the run. */
function selectTail(lines: Selected[], show: number): Selected[] {
  if (lines.length <= show) return lines;
  if (show === 1) {
    const useful = lines.findLast(({ line }) => {
      const text = cleanOutput(line).trim();
      return /^.{2}/u.test(text) && !/^[\s()[\]{},;]+$/u.test(text);
    });
    // A notice alone stands for the whole body, below the header.
    return useful ? [useful] : [notice(lines.length, "below")];
  }
  // The hidden lines come before the kept ones, so the notice heads them.
  const kept = show - 1;
  return [notice(lines.length - kept, "above"), ...lines.slice(-kept)];
}

const DIFF_HINT = /^(diff --git|@@ )/m;

/** pi's read answers with a note instead of file lines for an image or a first line over its byte limit. */
const READ_NOTE = /^(?:Read image file \[|\[Line \d+ is [^\n]*\]$)/;

/** Code needs this many columns beside the gutter, or the block shows code only. */
const MIN_CODE_WIDTH = 20;

/**
 * The file line a read starts at: its `offset` (1-based, like pi's). Undefined when
 * the lines are not numbered from a known start. Shell output numbers itself through
 * its command (`render/shell-output.ts`).
 */
function firstLine(input: ToolRowInput, text: string): number | undefined {
  if (input.error || input.name !== "read" || READ_NOTE.test(text)) return undefined;
  // pi starts at `offset - 1` as an index, so a fractional offset reads from its whole part.
  const offset = Number(input.args?.offset);
  return Number.isFinite(offset) && offset >= 1 ? Math.trunc(offset) : 1;
}

/** Structured JSON results use pi's JSON grammar. */
function jsonLanguage(text: string): string | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    JSON.parse(text);
    return "json";
  } catch {
    // A partial result or an ordinary log can start with the same characters.
    return undefined;
  }
}

function outputLanguage(input: ToolRowInput, text: string, kit: RenderKit): string | undefined {
  if (input.name === "read" || input.name === "write" || input.name === "edit") {
    const path = input.args?.path ?? input.args?.file_path ?? input.title;
    return typeof path === "string" ? kit.languageFromPath?.(path) : undefined;
  }
  return jsonLanguage(text);
}

/** A shell command's output read through its command; undefined when the body is not plain output. */
function shellViewOf(
  input: ToolRowInput,
  text: string,
  languageFromPath?: (path: string) => string | undefined,
): ShellView | undefined {
  const command = input.args?.command;
  // A failed call shows its error, and a diff keeps its change colours.
  if (input.error || typeof command !== "string" || toolMeta(input.name).cls !== "shell" || DIFF_HINT.test(text))
    return undefined;
  return shellView(command, text, {
    complete: input.status === "success",
    ...(languageFromPath ? { languageFromPath } : {}),
    sniff: jsonLanguage,
  });
}

/**
 * In a preview, blank lines carry no evidence and take no row, but every line keeps its number in
 * the file. An opened block shows one file's numbered lines as they are, blank lines included.
 */
function takesRow(line: ShellLine, opened = false): boolean {
  if (line.kind === "divider") return true;
  if (opened && line.kind === "code" && line.number !== undefined) return true;
  return (line.kind === "plain" ? line.text : line.code).trim() !== "";
}

/**
 * How many rows the body's lines take with nothing hidden: its non-blank lines, less those a
 * shell command's output gives no row (a blank line after grep's prefix, a `--` where the file
 * changes). More than the level's budget means the preview hides some.
 */
export function previewLineCount(input: ToolRowInput): number {
  const raw = previewText(input);
  const text = cleanOutput(raw);
  const files = changeRows(input.changes).length;
  // A diff's rows are its lines and the dividers between hunks; an edit's headers take none.
  if (isDiff(input, text)) return diffRows(logicalLines(text), input.name === "edit").length + files;
  const view = shellViewOf(input, text);
  return (view ? view.lines.filter((line) => takesRow(line)).length : nonEmptyLineCount(raw)) + files;
}

/** Whether a body reads as a diff: an edit's patch, or a shell command's output that is one. */
function isDiff(input: ToolRowInput, text: string): boolean {
  const cls = toolMeta(input.name).cls;
  return (
    !input.error &&
    // A write previews the file it wrote: its `-`/`+` lines are content, not changes.
    ((DIFF_HINT.test(text) && (cls === "edit" || cls === "shell")) ||
      (input.name === "edit" && /^[+-] *\d+ /m.test(text)))
  );
}

/**
 * A shell command's output read through its command, when the command says what it printed:
 * a range of one file, or grep's matches. Each line keeps its number and its file; the code is
 * highlighted per run of one file's adjacent lines, within the same work bound as a read.
 */
function shellRows(
  api: RenderApi,
  input: ToolRowInput,
  text: string,
): { lines: Selected[]; view: ShellView } | undefined {
  const { kit, theme } = api;
  const view = shellViewOf(input, text, kit.languageFromPath);
  if (!view) return undefined;
  const highlight = kit.highlight;
  const styled =
    highlight && text.length <= MAX_FORMAT_CHARS
      ? highlightShellLines(view.lines, (source, language) => highlight(source, language, theme, api.owner))
      : [];
  const lines = view.lines.flatMap((line, index): Selected[] => {
    if (!takesRow(line, !!input.full && view.contiguous)) return [];
    if (line.kind === "divider") return [{ line: "", rule: "divider" }];
    if (line.kind === "plain") return [{ line: line.text }];
    return [
      {
        line: styled[index] ?? line.code,
        ...(line.number === undefined ? {} : { number: line.number }),
        ...(line.path === undefined ? {} : { path: line.path }),
      },
    ];
  });
  return { lines, view };
}

/**
 * A path row above each kept line whose file differs from the kept line before it, so a
 * preview that starts mid-output still names the file of its first line.
 */
function withPaths(selected: Selected[]): Selected[] {
  let current: string | undefined;
  return selected.flatMap((item) => {
    if (item.path === undefined || item.path === current) return [item];
    current = item.path;
    return [{ line: "", rule: "path", path: item.path }, item];
  });
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NUMBERED_ROW = /^[ +-] *(\d+) /;

/** A patch line's role, read from where it sits: a hunk's lines are counted from its header. */
type DiffKind = "header" | "hunk" | "add" | "del" | "context" | "meta";

interface DiffLine {
  kind: DiffKind;
  line: string;
  /** The line without its sign, and without the number pi's display diff writes after it. */
  code: string;
  /** The line's number in its file: removed lines in the old file, the rest in the new. */
  number?: number;
  /** Which hunk the line belongs to; a `hunk` line starts the next one. */
  hunk: number;
}

/** File headers git and `diff -u` write before a file's first hunk. */
const DIFF_HEADER =
  /^(diff --git|index |new file|deleted file|old mode|new mode|similarity |dissimilarity |rename |copy |Binary files |--- |\+\+\+ )/;
/** pi's display diff marks the unchanged lines it skips with an indented `...`. */
const DISPLAY_GAP = /^ +\.\.\.$/;

/**
 * Each patch line's role and number. A unified patch counts from its hunk headers, so a hunk ends
 * when both its sides are counted: a removed line reading `--- x` (`-- x` in SQL or Lua) is a line
 * of the file, not a file header. pi's display diff writes each number after the sign.
 */
function parseDiff(lines: string[], numbered: boolean): DiffLine[] {
  let hunk = 0;
  if (numbered) {
    return lines.map((line): DiffLine => {
      if (DISPLAY_GAP.test(line)) return { kind: "hunk", line, code: line, hunk: ++hunk };
      const match = NUMBERED_ROW.exec(line);
      if (!match) return { kind: "meta", line, code: line, hunk };
      const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "context";
      return { kind, line, code: line.replace(NUMBERED_ROW, ""), number: Number(match[1]), hunk };
    });
  }
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line): DiffLine => {
    const header = HUNK.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      return { kind: "hunk", line, code: line, hunk: ++hunk };
    }
    // `\ No newline at end of file` belongs to the line before it.
    if (line.startsWith("\\")) return { kind: "meta", line, code: line, hunk };
    if (oldLeft <= 0 && newLeft <= 0)
      return { kind: DIFF_HEADER.test(line) ? "header" : "meta", line, code: line, hunk };
    const code = line.slice(1);
    if (line.startsWith("+")) {
      newLeft--;
      return { kind: "add", line, code, number: newLine++, hunk };
    }
    if (line.startsWith("-")) {
      oldLeft--;
      return { kind: "del", line, code, number: oldLine++, hunk };
    }
    oldLeft--;
    newLeft--;
    oldLine++;
    return { kind: "context", line, code, number: newLine++, hunk };
  });
}

/**
 * A diff's rows. An edit's rows carry their numbers for the gutter and read sign then code. Its
 * file and hunk headers go: the row header names the file and the gutter numbers the lines, and a
 * divider in the number column marks the jump between hunks. Each side of a hunk is highlighted on
 * its own, so removed syntax cannot bleed into additions. A shell command's diff keeps its text as
 * it came, coloured by the same reading of the patch.
 */
function diffRows(lines: string[], edit: boolean, highlight?: (source: string) => string[] | undefined): Selected[] {
  const parsed = parseDiff(lines, edit && !lines.some((line) => line.startsWith("@@ ")));
  const rows: Selected[] = [];
  /** The patch line behind each numbered row: its side and hunk, for highlighting. */
  const code = new Map<Selected, DiffLine>();
  for (const source of parsed) {
    // Blank lines carry no evidence and take no row, but every line keeps its number in the file.
    if (!source.line.trim()) continue;
    const change = source.kind === "add" ? "success" : source.kind === "del" ? "error" : undefined;
    if (!edit) {
      // Output cut before its first hunk header (`git diff | tail`) has no counts to read: its
      // changes keep the colour of their sign.
      const cut =
        source.kind === "meta" && source.hunk === 0
          ? source.line.startsWith("+")
            ? "success"
            : source.line.startsWith("-")
              ? "error"
              : undefined
          : undefined;
      const tone = change ?? cut ?? (source.kind === "hunk" ? "accent" : source.kind === "header" ? "dim" : undefined);
      const context = source.kind === "context" || source.kind === "header";
      rows.push({ line: source.line, ...(tone ? { tone } : {}), ...(context ? { context } : {}) });
    } else if (source.kind === "hunk") rows.push({ line: "", rule: "divider" });
    else if (source.number !== undefined) {
      const row: Selected = {
        line: source.line,
        styled: source.line[0] + source.code,
        number: source.number,
        ...(change ? { tone: change, bg: true } : { context: true }),
      };
      code.set(row, source);
      rows.push(row);
    } else if (source.kind !== "header") rows.push({ line: source.line, tone: "dim", context: true });
  }
  if (highlight) {
    const hunks = new Map<number, Array<[Selected, DiffLine]>>();
    for (const entry of code) {
      const hunk = hunks.get(entry[1].hunk);
      if (hunk) hunk.push(entry);
      else hunks.set(entry[1].hunk, [entry]);
    }
    for (const hunk of hunks.values()) {
      for (const side of ["del", "add"]) {
        const sided = hunk.filter(([, source]) => source.kind === side || source.kind === "context");
        if (!sided.length) continue;
        const styled = highlight(sided.map(([, source]) => source.code).join("\n")) ?? [];
        sided.forEach(([row, source], index) => {
          row.styled = row.line[0] + (styled[index] ?? source.code);
        });
      }
    }
  }
  return tidyDividers(rows);
}

/** What a changed file without a diff shows instead. */
function changeNote(file: FileChange): string | undefined {
  // The path row's `D` already says it.
  if (file.kind === "deleted") return undefined;
  if (file.note === "binary") return file.kind === "created" ? "new binary file" : "binary file changed";
  if (file.note === "too large") return file.kind === "created" ? "new file, too large to diff" : "too large to diff";
  if (!file.patch?.trim()) return file.kind === "created" ? "new empty file" : "changed, same content";
  return undefined;
}

/**
 * The rows of the files a shell command changed: a path row per file, then its diff read like an
 * edit's (numbered, headers dropped, changes on the edit backgrounds), or a note saying why there
 * is none. Each file's code takes the syntax colours of its language.
 */
function changeRows(
  changes: FileChanges | undefined,
  highlight?: (file: FileChange) => ((code: string) => string[] | undefined) | undefined,
): Selected[] {
  if (!changes) return [];
  const rows = changes.files.flatMap((file): Selected[] => {
    const patch = logicalLines(cleanOutput(file.patch ?? ""));
    const added = patch.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = patch.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const path: Selected = { line: "", rule: "path", path: file.path, change: { kind: file.kind, added, removed } };
    const note = changeNote(file);
    if (note !== undefined) return [path, { line: note, rule: "note" }];
    if (file.kind === "deleted") return [path];
    return [path, ...diffRows(patch, true, highlight?.(file))];
  });
  const more = changes.more ?? 0;
  if (more > 0) rows.push({ line: `${more} more file${more === 1 ? "" : "s"} changed`, rule: "note" });
  return rows;
}

/**
 * pi's read ends a partial range with how to continue it: `[N more lines in file. Use offset=X
 * to continue.]` after a `limit`, or `[Showing lines A-B of T. Use offset=X to continue.]`, with
 * the byte limit in parentheses when that cut it.
 */
const READ_TRAILER =
  /\n\n\[(?:(\d+) more lines in file|Showing lines \d+-(\d+) of (\d+)(?: \([^)\n]*\))?)\. Use offset=\d+ to continue\.\]$/;

/** A read's file lines, and how many lines of the file follow them when pi says so. */
export function splitReadTrailer(output: string): { content: string; remaining?: number } {
  const match = READ_TRAILER.exec(output);
  if (!match) return { content: output };
  const remaining = match[1] === undefined ? Number(match[3]) - Number(match[2]) : Number(match[1]);
  return { content: output.slice(0, match.index), remaining };
}

/** The text a body previews: a write's content, a read's lines without pi's continuation note, or the output. */
export function previewText(input: Pick<ToolRowInput, "name" | "args" | "output" | "error">): string {
  if (input.name === "write" && !input.error && typeof input.args?.content === "string" && input.args.content.length) {
    return input.args.content;
  }
  const output = input.output ?? "";
  return input.name === "read" && !input.error ? splitReadTrailer(output).content : output;
}

const rowCount = (items: string[][]) => items.reduce((sum, rows) => sum + rows.length, 0);

interface BodyLayout {
  rows: string[];
  /** A preview cut a line at the terminal width, so opening the row shows more. */
  clipped: boolean;
  /** For a preview: where its rows sit in the whole body, one cell per body row (the last rows). */
  bar?: BarCell[];
  /** For a preview: the source line each body row shows; undefined for a notice. */
  sources?: Array<number | undefined>;
  /** For a preview: the row of the notice whose lines opening the block shows, when there is one. */
  omission?: number;
  /** What the header row does not show of its title, so opening the row shows it. */
  hiddenTitle?: string;
}

/** Cut wrapped rows to `room`, ending the last kept row with the cut mark. */
function clipRows(kit: RenderKit, rows: string[], room: number, width: number, mark: string): string[] {
  if (rows.length <= room) return rows;
  const kept = rows.slice(0, Math.max(0, room));
  if (kept.length) kept[kept.length - 1] = kit.truncateToWidth(kept.at(-1)! + mark, width, mark);
  return kept;
}

/**
 * The body under a header, in at most `budget` rows. A preview gives each line
 * one row, cut at the width. An expanded row wraps long lines, and wrapped rows
 * count against the same budget as everything else.
 */
function body(api: RenderApi, input: ToolRowInput, width: number, total: number): BodyLayout {
  const { theme, kit } = api;
  const empty: BodyLayout = { rows: [], clipped: false };
  if (total <= 0) return empty;

  const meta = toolMeta(input.name);
  const text = cleanOutput(input.error ? errorDetail(input, meta) : previewText(input));
  const source = logicalLines(text);
  const diff = isDiff(input, text);
  const shell = !input.error && !diff ? shellRows(api, input, text) : undefined;
  // Bound grammar work on oversized tool results. pi reads normally stop at 50 KiB.
  const language =
    !shell && !input.error && (!diff || input.name === "edit") && text.length <= MAX_FORMAT_CHARS && kit.highlight
      ? outputLanguage(input, text, kit)
      : undefined;
  const styledSource = language && !diff ? kit.highlight?.(text, language, theme, api.owner) : undefined;
  // In a preview, blank lines carry no evidence and take no row, but every line keeps its number
  // in the file. An opened block shows the file as it is, blank lines included.
  const start = diff ? undefined : firstLine(input, text);
  const lines: Selected[] =
    shell?.lines ??
    source.flatMap((line, raw) =>
      line.trim() || (input.full && start !== undefined)
        ? [{ line: styledSource?.[raw] ?? line, ...(start === undefined ? {} : { number: start + raw }) }]
        : [],
    );
  const highlight = kit.highlight;
  /**
   * A changed file's diff takes the syntax colours of its language, within a read's work bound:
   * the files' patches share `MAX_FORMAT_CHARS`, in order, and one that would overrun it stays plain.
   */
  let formatted = 0;
  const fileHighlight = (file: FileChange) => {
    const fileLanguage = highlight && kit.languageFromPath?.(file.path);
    const size = file.patch?.length ?? 0;
    if (!fileLanguage || formatted + size > MAX_FORMAT_CHARS) return undefined;
    formatted += size;
    return (code: string) => highlight(code, fileLanguage, theme);
  };
  const changed = changeRows(input.changes, fileHighlight);
  if (lines.length === 0 && changed.length === 0) return empty;
  // The lines pi's read left in the file: a notice on the last row, which the code may not take.
  // It gives way when the rows left would hold a notice and no line of code.
  const remaining = input.name === "read" && !input.error ? splitReadTrailer(input.output ?? "").remaining : undefined;
  const fileNote = remaining && total - 1 >= Math.min(2, lines.length) ? remaining : undefined;
  const budget = fileNote ? total - 1 : total;

  const streamingWrite = input.name === "write" && input.status === "pending" && !input.expanded;
  const trend = streamingWrite || meta.trend === "tail" ? selectTail : selectHead;
  const patchRows = diff
    ? indexLines(
        diffRows(
          source,
          input.name === "edit",
          language && highlight ? (code) => highlight(code, language, theme) : undefined,
        ),
      )
    : [];
  const indexed = lines.map((line, index): Selected => ({ ...line, index }));
  const pick = (show: number) => (diff ? selectDiff(patchRows, show) : trend(indexed, show));
  const paths = !!shell?.view.paths;
  // Path rows take rows too: keep fewer lines until the lines and their path rows fit.
  const selectOutput = (show: number): Selected[] => {
    if (!paths) return pick(show);
    // Dropping a line drops at most one path row too, so the lines that fit are at most
    // half the overshoot fewer: step down by that much, never past the most that fit.
    for (let kept = Math.min(show, lines.length); kept >= 1; ) {
      const rows = withPaths(pick(kept));
      if (rows.length <= show) return rows;
      kept -= Math.ceil((rows.length - show) / 2);
    }
    return pick(show);
  };
  const outputLines = diff ? lineCount(patchRows) : lines.length;
  const outputRows = diff ? patchRows.length : paths ? withPaths(indexed).length : lines.length;
  // The files a command changed come after its output, numbered on from its lines.
  const files = indexLines(changed).map((row) =>
    row.index === undefined ? row : { ...row, index: outputLines + row.index },
  );
  /**
   * The output and the changed files share the budget. When both cannot fit, the files take the
   * larger half, the output at least one row, and either gives the other what it does not use.
   */
  const select = (show: number): Selected[] => {
    if (!files.length) return selectOutput(show);
    if (outputRows + files.length <= show) return [...selectOutput(outputRows), ...files];
    const share = Math.min(outputRows, Math.max(1, show - files.length, Math.floor(show / 2)));
    const output = share > 0 ? selectOutput(share) : [];
    return [...output, ...selectDiff(files, show - output.length)];
  };
  // grep's numbers jump where it skipped lines: a gap there is not a run of hidden lines.
  const contiguous = shell?.view.contiguous ?? true;

  const indent = blockBodyIndent(width);
  const inner = Math.max(1, width - indent.length);
  const wrap = !!(input.expanded || input.full);
  const mark = cutMark(theme);
  let clipped = false;
  // Wrapping is the costly step and a selection can repeat lines: do each once per width.
  const wrapped = new Map<string, string[]>();
  /**
   * A notice row. Beside numbered code its glyph sits right-aligned in the
   * number column and its words start in the code column, so the gutter and
   * the code stay two clean columns.
   */
  const noticeRow = (label: string, digits: number): string => {
    const space = label.indexOf(" ");
    const aligned =
      digits && space > 0
        ? " ".repeat(Math.max(0, digits - kit.visibleWidth(label.slice(0, space)))) +
          label.slice(0, space) +
          "  " +
          label.slice(space + 1)
        : label;
    return indent + kit.truncateToWidth(omissionStyle(theme, aligned, input.lit), inner, mark);
  };
  /** `digits` is the gutter's number width; 0 when the block has no gutter. */
  const paint = (
    { line, styled, notice: hidden, number, rule, path, change, tone, bg }: Selected,
    digits: number,
  ): string[] => {
    if (hidden) return [noticeRow(omittedLinesLabel(hidden.count, hidden.side, api.glyphs), digits)];
    // grep's divider sits in the number column, like a notice's glyph; a path row starts where the numbers start.
    if (rule === "divider") {
      const glyph = api.glyphs.between;
      const aligned = " ".repeat(Math.max(0, digits - kit.visibleWidth(glyph))) + glyph;
      return [indent + kit.truncateToWidth(omissionStyle(theme, aligned), inner, mark)];
    }
    // A changed file's row reads like `git status --short` with the diff's size: `M src/a.ts  +3 -1`.
    if (rule === "path" && change) {
      const status = { created: ["A", "success"], modified: ["M", "warning"], deleted: ["D", "error"] } as const;
      const [letter, letterTone] = status[change.kind];
      const counts = [
        change.added ? theme.fg("success", `+${change.added}`) : "",
        change.removed ? theme.fg("error", `-${change.removed}`) : "",
      ]
        .filter(Boolean)
        .join(" ");
      const head = `${theme.style(letter, { fg: letterTone, bold: true })} `;
      const tail = counts ? `  ${counts}` : "";
      const room = Math.max(1, inner - kit.visibleWidth(head) - kit.visibleWidth(tail));
      return [indent + head + truncateLeft(kit, path ?? "", room, mark, (part) => theme.fg("text", part)).text + tail];
    }
    if (rule === "path")
      return [indent + truncateLeft(kit, path ?? "", inner, mark, (part) => theme.fg("dim", part)).text];
    // A changed file's note sits in the code column, in the notice style.
    if (rule === "note") {
      const lead = " ".repeat(digits ? digits + 2 : 0);
      return [indent + kit.truncateToWidth(lead + omissionStyle(theme, line), inner, mark)];
    }
    const gutter = digits && number !== undefined ? digits + 2 : 0;
    const room = inner - gutter;
    const content = styled ?? line;
    let parts: string[];
    if (wrap) {
      const key = `${room}:${content}`;
      parts = wrapped.get(key) ?? [];
      if (!wrapped.has(key)) {
        // No line can need more than the whole budget: bound the wrap work.
        parts = kit.wrap(kit.truncateToWidth(content, room * (budget + 1), ""), room);
        wrapped.set(key, parts);
      }
    } else {
      const cut = kit.truncateToWidth(content, room, mark);
      if (cut !== content) clipped = true;
      parts = [cut];
    }
    return parts.map((part, row) => {
      // The number heads the line's first row; its wrapped rows keep the column blank.
      const lead = !gutter ? "" : row ? " ".repeat(gutter) : `${theme.fg("dim", String(number).padStart(digits))}  `;
      if (bg && (tone === "success" || tone === "error")) {
        const padding = " ".repeat(Math.max(0, room - kit.visibleWidth(part)));
        return (
          indent + theme.style(lead + part + padding, { bg: tone === "success" ? "toolSuccessBg" : "toolErrorBg" })
        );
      }
      return indent + lead + (tone ? theme.fg(tone, part) : theme.fg("toolOutput", part));
    });
  };
  /** The gutter fits the widest number shown, unless it would leave the code too narrow. */
  const gutterDigits = (selected: Selected[]): number => {
    const widest = selected.reduce((max, item) => Math.max(max, item.number ?? 0), 0);
    const digits = widest ? String(widest).length : 0;
    return digits && inner - digits - 2 >= MIN_CODE_WIDTH ? digits : 0;
  };
  const layout = (selected: Selected[]) => {
    const digits = gutterDigits(selected);
    return selected.map((item, index) =>
      paint(digits && !diff && contiguous ? spanCount(selected, index) : item, digits),
    );
  };

  // A notice counts against the budget: total body rows never exceed it.
  const show = Math.min(budget, outputRows + files.length);
  let selected = select(show);
  let items = layout(selected);
  if (wrap && rowCount(items) > budget) {
    // Wrapping overflowed: keep the most lines that still fit, chosen by the same trend.
    let low = 1;
    let high = show - 1;
    let best: { selected: Selected[]; items: string[][] } | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = select(mid);
      const candidateItems = layout(candidate);
      if (rowCount(candidateItems) <= budget) {
        best = { selected: candidate, items: candidateItems };
        low = mid + 1;
      } else high = mid - 1;
    }
    if (best) ({ selected, items } = best);
    else {
      selected = select(1);
      items = layout(selected);
    }
  }
  // Still over: a single line alone outgrows the budget. Notices, dividers and path rows keep their row.
  let room = budget - selected.filter((item) => item.notice || item.rule).length;
  const rows = items.flatMap((item, index) => {
    if (selected[index]?.notice || selected[index]?.rule) return item;
    const kept = clipRows(kit, item, room, width, mark);
    room -= kept.length;
    return kept;
  });
  if (fileNote)
    rows.push(noticeRow(`${omittedLinesLabel(fileNote, "below", api.glyphs)} in file`, gutterDigits(selected)));
  if (wrap) return { rows, clipped };
  const shown = new Set(selected.flatMap((item) => (item.index === undefined ? [] : [item.index])));
  // The file note hides lines no click can show; only a notice among the selected lines opens.
  const omission = selected.findIndex((item) => item.notice);
  return {
    rows,
    clipped,
    bar: previewBar(outputLines + lineCount(files), shown, rows.length),
    // One row per selected line, then the file note: a preview never wraps.
    sources: [...selected.map((item) => item.index), ...(fileNote ? [undefined] : [])],
    ...(omission === -1 ? {} : { omission }),
  };
}

/** The header, an opened command's continuation rows, and the body: one row budget for all. */
export function toolRowLayout(api: RenderApi, input: ToolRowInput, width: number): BodyLayout {
  const { line, continuation, hiddenTitle } = toolHeader(api, input, width);
  const rows = [line];
  // A "full" read is allowed to be long, just not unbounded.
  let budget = input.full ? MAX_FULL_LINES : bodyLinesFor(input.level, input.expanded ?? false);
  if (continuation?.rows.length) {
    // The command is evidence too, but it may not crowd out the output.
    const hasOutput = nonEmptyLineCount(cleanOutput(input.error ? input.error : previewText(input))) > 0;
    const room = hasOutput ? Math.ceil(budget / 2) : budget;
    const { column, rows: lines } = continuation;
    const command =
      lines.length <= room
        ? lines
        : [
            ...lines.slice(0, room - 1),
            " ".repeat(column) +
              omissionStyle(api.theme, omittedLinesLabel(lines.length - (room - 1), "below", api.glyphs), input.lit),
          ];
    rows.push(...command);
    budget -= command.length;
  }
  const { rows: bodyRows, clipped, bar, sources, omission } = body(api, input, width, budget);
  return {
    rows: rows.concat(bodyRows),
    clipped,
    ...(bar ? { bar, sources } : {}),
    ...(omission === undefined ? {} : { omission: rows.length + omission }),
    ...(hiddenTitle ? { hiddenTitle } : {}),
  };
}

/**
 * The row of the layout that the next level drops: the first row whose source
 * line the next level no longer shows. Notices change text from level to level,
 * so lines are compared by source, not by what they read. Undefined when the
 * next level keeps every line.
 */
export function leavingRow(api: RenderApi, input: ToolRowInput, width: number): number | undefined {
  if (input.expanded || input.full) return undefined;
  const now = toolRowLayout(api, input, width);
  const next = toolRowLayout(api, { ...input, level: Math.min(input.level + 1, COMPACT_LEVEL) as DetailLevel }, width);
  if (!now.sources || !next.sources) return undefined;
  const kept = new Set(next.sources);
  const index = now.sources.findIndex((source) => source !== undefined && !kept.has(source));
  return index < 0 ? undefined : now.rows.length - now.sources.length + index;
}

export function renderToolRow(api: RenderApi, input: ToolRowInput): ComponentLike {
  return api.kit.component((width) => toolRowLayout(api, input, width).rows);
}

/** One collapsed row, no body: the aged 3 form. */
export function renderToolLine(api: RenderApi, input: ToolRowInput): ComponentLike {
  return api.kit.component((width) => [toolHeader(api, input, width).line]);
}
