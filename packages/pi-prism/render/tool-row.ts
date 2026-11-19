/**
 * Tool row: one header line plus a bounded body. The body budget is the whole
 * point: the closer a row is to the tail, the more of its output survives.
 */

import { bodyLinesFor, COMPACT_LEVEL, MAX_FULL_LINES, type DetailLevel } from "./detail.ts";
import { frameAt, type GlyphSet } from "./glyphs.ts";
import { cellPadding, metricColumns, tableFits, type MemberCells, type MemberColumns } from "./columns.ts";
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
import { describeCall, formatRate, toolTokenCounts, toolMeta, toolTokenLabel, type TokenRates } from "./tools.ts";

export interface RenderApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
  owner?: object;
}

export type ToolStatus = "pending" | "running" | "success" | "error";

export interface ToolRowInput extends TokenRates {
  name: string;
  args?: Record<string, unknown>;
  status: ToolStatus;
  level: DetailLevel;
  expanded?: boolean;
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
}

/** The verb a tool row leads with: `bash`, `read`, an MCP `server/tool`. */
export function toolLabel(name: string): string {
  return oneLine(toolMeta(name).label);
}

/** Diff lines keep their meaning under decay: additions green, removals red. */
function diffTone(line: string): "success" | "error" | "accent" | "dim" | undefined {
  if (
    line.startsWith("+++ ") ||
    line.startsWith("--- ") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ")
  ) {
    return "dim";
  }
  if (line.startsWith("@@")) return "accent";
  if (line.startsWith("+")) return "success";
  if (line.startsWith("-")) return "error";
  return undefined;
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
  const chars = [...text];
  const room = width - kit.visibleWidth(mark);
  if (room <= 0) return { text: kit.truncateToWidth(mark, width, ""), cut: true };
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return {
    text: `${paint(chars.slice(0, head).join(""))}${mark}${tail > 0 ? paint(chars.slice(-tail).join("")) : ""}`,
    cut: true,
  };
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
 */
function splitAt(kit: RenderKit, line: string, width: number): [string, string] {
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
  const cut = space > 0 ? space : Math.max(1, end);
  return [chars.slice(0, cut).join("").trimEnd(), chars.slice(cut).join("").trimStart()];
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
export function styleMetric(theme: RenderTheme, label: string): string {
  return (label.match(/\d+(?:\.\d+)?k?|[a-z]+|[^a-z\d]+/gi) ?? [])
    .map((part) => {
      if (/^\d/.test(part)) return theme.fg("text", part);
      if (part === "out") return theme.fg("syntaxKeyword", part);
      if (part === "in") return theme.fg("syntaxType", part);
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
    ...(input.outputRate ? { outRate: formatRate(input.outputRate) } : {}),
    inValue: formatRate(inputTokens),
    ...(input.inputRate ? { inRate: `${input.inputRateEstimated ? "~" : ""}${formatRate(input.inputRate)}` } : {}),
    ...(input.durationMs !== undefined ? { duration: formatDuration(input.durationMs) } : {}),
  };
}

export function toolHeader(api: RenderApi, input: ToolRowInput, width: number) {
  const { theme, glyphs, kit } = api;
  const meta = toolMeta(input.name);
  // Names, titles, summaries and errors come from the model or the tool: never trust them.
  const label = toolLabel(input.name);
  const title = oneLine(input.title ?? describeCall(input.name, input.args).title);
  const summary = input.summary === undefined ? undefined : oneLine(input.summary);
  const { outputTokens, inputTokens } = toolTokenCounts(input);
  const tokens = toolTokenLabel(outputTokens, inputTokens, input);

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
  if (!input.columns) pieces.push({ kind: "tokens", text: styleMetric(theme, tokens) });
  else if (tableFits(input.columns, width))
    pieces.push({ kind: "tokens", text: styleMetric(theme, metricColumns(toolRowCells(input), input.columns)) });
  const error = errorHeadline(input, meta);
  if (error) pieces.push({ kind: "error", text: theme.fg("error", error) });
  const duration =
    input.durationMs === undefined || input.columns ? undefined : styleMetric(theme, formatDuration(input.durationMs));
  if (duration) pieces.push({ kind: "duration", text: duration });

  const compose = (parts: HeaderPiece[]) => parts.reduce((acc, part) => `${acc}${sep}${part.text}`, prefix);

  // Reserve space for the running shell clock if even a shortened command fits beside it.
  const keepClock = duration && kit.visibleWidth(prefix + sep + mark + sep + duration) <= width;
  // Keep a readable portion of the command or path when fitting the metadata.
  const minimumWidth = (parts: HeaderPiece[]) =>
    kit.visibleWidth(
      compose(
        parts.map((piece) =>
          piece.kind === "title"
            ? { ...piece, text: kit.truncateToWidth(title, input.inputRate || input.outputRate ? 8 : 20, mark) }
            : piece,
        ),
      ),
    );
  const required = pieces.filter((piece) => piece.kind !== "summary" && (piece.kind !== "duration" || keepClock));
  if (minimumWidth(required) > width) pieces = pieces.filter((piece) => piece.kind !== "tokens");
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
  const command = input.name === "bash" ? cleanOutput(String(input.args?.command ?? title)) : "";
  const hiddenCommand = command && (truncated || command !== title) ? command : undefined;
  /** Opened: the command's rows after the header, each starting in `column`. */
  let continuation: { column: number; rows: string[] } | undefined;
  if (titlePiece && hiddenCommand && (input.expanded || input.full)) {
    // Opened: the header carries the command's first segment, and the rest continues on the
    // following rows in the column where the command starts.
    const column = kit.visibleWidth(prefix + sep);
    const [first = "", ...lines] = hiddenCommand.split("\n");
    const [head, rest] = splitAt(kit, first, Math.max(1, room));
    titlePiece.text = theme.fg("accent", head);
    const inner = Math.max(1, width - column);
    continuation = {
      column,
      rows: (rest ? [rest, ...lines] : lines).flatMap((line) =>
        // No line can need more rows than the whole cap: bound the wrap work.
        kit
          .wrap(kit.truncateToWidth(line, inner * (MAX_FULL_LINES + 1), ""), inner)
          .map((part) => " ".repeat(column) + theme.fg("accent", part)),
      ),
    };
  } else if (titlePiece && truncated) {
    const truncate = meta.cls === "shell" ? truncateMiddle : truncateLeft;
    titlePiece.text = truncate(kit, title, room, mark, (part) => theme.fg("accent", part)).text;
  }

  const metrics = pieces.filter((part) => part.kind === "tokens" || part.kind === "duration");
  if (!metrics.length) return { line: kit.truncateToWidth(compose(pieces), width, mark), hiddenCommand, continuation };
  const left = compose(pieces.filter((part) => !metrics.includes(part))) + sep;
  const right = metrics.map((part) => part.text).join(sep);
  const line = kit.truncateToWidth(
    left + " ".repeat(Math.max(0, width - kit.visibleWidth(left + right))) + right,
    width,
    mark,
  );
  return { line, hiddenCommand, continuation };
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
}

/** One cell of a block's scroll bar, drawn in column 1. */
export type BarCell = "fill" | "track";

/**
 * A preview's position in the whole body, one cell per preview row: each cell
 * stands for an equal share of the source lines and is filled when the preview
 * shows any of them. A tail of a long log fills only the bottom cell.
 */
export function previewBar(total: number, shown: ReadonlySet<number>, rows: number): BarCell[] {
  return Array.from({ length: rows }, (_, row): BarCell => {
    if (shown.size >= total) return "fill";
    const from = Math.floor((row * total) / rows);
    const to = Math.max(from + 1, Math.floor(((row + 1) * total) / rows));
    for (let index = from; index < to; index++) if (shown.has(index)) return "fill";
    return "track";
  });
}

/** Diff metadata and unchanged context are the first rows to go. */
const DIFF_NOISE = /^(diff --git|index |new file|deleted file|similarity |rename |--- |\+\+\+ )/;
const isDiffContext = (line: string): boolean => DIFF_NOISE.test(line) || line.startsWith(" ");

const notice = (count: number, side: OmissionSide): Selected => ({ line: "", notice: { count, side } });

/**
 * Diffs keep what changed. Before hiding any hunk, drop the unchanged context
 * lines: the +/- rows carry the evidence, context is what a reader can infer.
 */
function selectDiff(lines: Selected[], show: number): Selected[] {
  if (lines.length <= show) return lines;

  const essential = lines.filter(({ line }) => !isDiffContext(line));
  const contextHidden = lines.length - essential.length;
  if (essential.length + 1 <= show) {
    // The dropped context sat between the changes kept in order.
    return [...essential, notice(contextHidden, "between")];
  }

  // Still too long: read the evidence in order, and say how much is left below it.
  const kept = show - 1;
  const hidden = lines.length - kept;
  return [...essential.slice(0, kept), notice(hidden, "below")];
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

// Only recognise commands whose stdout is a single literal file or range of that file.
const SHELL_FILE =
  /^(?:cd\s+[\w./~-]+\s*&&\s*)?(?:cat(?:\s+--)?|sed\s+-n\s+['"]?(\d+)(?:,\d+)?p['"]?)\s+(?:"([\w./ ~-]+)"|'([\w./ ~-]+)'|([\w./~-]+))\s*$/u;

/**
 * pi's bash keeps the tail of a long output and says so last: its lines no longer start at the
 * file's first. Its partial results while running are cut the same way, without the note.
 */
const SHELL_TRUNCATED = /\n\n\[Showing [^\n]*Full output: [^\n]*\]$/;

/** pi's read answers with a note instead of file lines for an image or a first line over its byte limit. */
const READ_NOTE = /^(?:Read image file \[|\[Line \d+ is [^\n]*\]$)/;

/** Code needs this many columns beside the gutter, or the block shows code only. */
const MIN_CODE_WIDTH = 20;

/**
 * The file line the output starts at, when the output is a literal range of one
 * file: a read from its `offset` (1-based, like pi's), `sed -n 'A,Bp'` from A,
 * `cat` from 1. Undefined when the lines are not numbered from a known start.
 */
function firstLine(input: ToolRowInput, text: string): number | undefined {
  if (input.error) return undefined;
  if (input.name === "read") {
    if (READ_NOTE.test(text)) return undefined;
    // pi starts at `offset - 1` as an index, so a fractional offset reads from its whole part.
    const offset = Number(input.args?.offset);
    return Number.isFinite(offset) && offset >= 1 ? Math.trunc(offset) : 1;
  }
  if (
    input.name === "bash" &&
    input.status === "success" &&
    typeof input.args?.command === "string" &&
    !SHELL_TRUNCATED.test(text)
  ) {
    const match = SHELL_FILE.exec(input.args.command);
    if (match) return match[1] === undefined ? 1 : Math.max(1, Number(match[1]));
  }
  return undefined;
}

function outputLanguage(input: ToolRowInput, text: string, kit: RenderKit): string | undefined {
  if (input.name === "read" || input.name === "write" || input.name === "edit") {
    const path = input.args?.path ?? input.args?.file_path ?? input.title;
    return typeof path === "string" ? kit.languageFromPath?.(path) : undefined;
  }
  if (input.name === "bash" && typeof input.args?.command === "string") {
    const match = SHELL_FILE.exec(input.args.command);
    if (match) return kit.languageFromPath?.(match[2] ?? match[3] ?? match[4]!);
  }
  if (/^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // A partial result or an ordinary log can start with the same characters.
    }
  }
  return undefined;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NUMBERED_ROW = /^[ +-] *(\d+) /;

/**
 * Each diff line's number in its file: pi's display diff writes it after the sign; a unified
 * patch counts from its hunk headers, removed lines in the old file, added and unchanged ones
 * in the new. A hunk ends when both its sides are counted, so a removed line reading `--- ` is
 * still a line, not a file header.
 */
function diffLineNumbers(lines: string[], numbered: boolean): Array<number | undefined> {
  if (numbered) return lines.map((line) => NUMBERED_ROW.exec(line)?.[1]).map((n) => (n ? Number(n) : undefined));
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((line) => {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      return undefined;
    }
    if (oldLeft <= 0 && newLeft <= 0) return undefined;
    if (line.startsWith("+")) {
      newLeft--;
      return newLine++;
    }
    if (line.startsWith("-")) {
      oldLeft--;
      return oldLine++;
    }
    // `\ No newline at end of file` belongs to the line before it.
    if (line.startsWith("\\")) return undefined;
    oldLeft--;
    newLeft--;
    oldLine++;
    return newLine++;
  });
}

/**
 * An edit's diff rows, each side of a hunk highlighted independently so removed syntax cannot
 * bleed into additions. An edit's lines carry their numbers for the gutter; pi's display diff
 * gives its own up, so a row reads sign then code.
 */
function editDiffRows(api: RenderApi, lines: string[], language: string | undefined, edit: boolean): Selected[] {
  const numbered = !lines.some((line) => line.startsWith("@@ "));
  const numbers = edit ? diffLineNumbers(lines, numbered) : [];
  const lift = edit && numbered;
  const rows = lines.map((line, raw): Selected => {
    const number = numbers[raw];
    if (number === undefined) return { line };
    return { line, number, ...(lift ? { styled: line[0] + line.replace(NUMBERED_ROW, "") } : {}) };
  });
  const highlight = api.kit.highlight;
  if (!language || !highlight) return rows;
  const prefix = numbered ? NUMBERED_ROW : /^[ +-]/;
  for (let start = 0; start < rows.length; start++) {
    if (!numbered && !rows[start]!.line.startsWith("@@ ")) continue;
    const first = numbered ? start : start + 1;
    let end = first;
    while (end < rows.length && prefix.test(rows[end]!.line)) end++;
    if (end === first) continue;
    const hunk = rows.slice(first, end);
    for (const side of ["-", "+"]) {
      const code = hunk.filter(({ line }) => line[0] === side || line[0] === " ");
      if (!code.length) continue;
      const styled = highlight(code.map(({ line }) => line.replace(prefix, "")).join("\n"), language, api.theme);
      code.forEach((row, index) => {
        const sign = lift ? row.line[0] : row.line.match(prefix)![0];
        row.styled = sign + (styled[index] ?? row.line.replace(prefix, ""));
      });
    }
    start = end - 1;
  }
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
  const diff =
    !input.error &&
    // A write previews the file it wrote: its `-`/`+` lines are content, not changes.
    ((DIFF_HINT.test(text) && ["edit", "shell"].includes(meta.cls)) ||
      (input.name === "edit" && /^[+-] *\d+ /m.test(text)));
  // Bound grammar work on oversized tool results. pi reads normally stop at 50 KiB.
  const language =
    !input.error && (!diff || input.name === "edit") && text.length <= MAX_FORMAT_CHARS && kit.highlight
      ? outputLanguage(input, text, kit)
      : undefined;
  const styledSource = language && !diff ? kit.highlight?.(text, language, theme, api.owner) : undefined;
  // Blank lines carry no evidence and take no row, but every line keeps its number in the file.
  const start = diff ? undefined : firstLine(input, text);
  const lines = source.flatMap((line, raw) =>
    line.trim() ? [{ line: styledSource?.[raw] ?? line, ...(start === undefined ? {} : { number: start + raw }) }] : [],
  );
  if (lines.length === 0) return empty;
  // The lines pi's read left in the file: a notice on the last row, which the code may not take.
  // It gives way when the rows left would hold a notice and no line of code.
  const remaining = input.name === "read" && !input.error ? splitReadTrailer(input.output ?? "").remaining : undefined;
  const fileNote = remaining && total - 1 >= Math.min(2, lines.length) ? remaining : undefined;
  const budget = fileNote ? total - 1 : total;

  const streamingWrite = input.name === "write" && input.status === "pending" && !input.expanded;
  const trend = streamingWrite || meta.trend === "tail" ? selectTail : selectHead;
  const diffRows = diff
    ? editDiffRows(api, source, language, input.name === "edit")
        .filter(({ line }) => line.trim())
        .map((row, index) => ({ ...row, index }))
    : [];
  const indexed = lines.map((line, index): Selected => ({ ...line, index }));
  const select = (show: number) => (diff ? selectDiff(diffRows, show) : trend(indexed, show));

  const indent = blockBodyIndent(width);
  const inner = Math.max(1, width - indent.length);
  const wrap = !!(input.expanded || input.full);
  const mark = cutMark(theme);
  let clipped = false;
  // Wrapping is the costly step and a selection can repeat lines: do each once per width.
  const wrapped = new Map<string, string[]>();
  /** `digits` is the gutter's number width; 0 when the block has no gutter. */
  const paint = ({ line, styled, notice: hidden, number }: Selected, digits: number): string[] => {
    if (hidden) {
      // A notice starts where the gutter starts: it counts lines, it is not one.
      const label = omittedLinesLabel(hidden.count, hidden.side, api.glyphs);
      return [indent + kit.truncateToWidth(omissionStyle(theme, label), inner, mark)];
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
    const tone = diff ? diffTone(line) : undefined;
    return parts.map((part, row) => {
      // The number heads the line's first row; its wrapped rows keep the column blank.
      const lead = !gutter ? "" : row ? " ".repeat(gutter) : `${theme.fg("dim", String(number).padStart(digits))}  `;
      if (diff && input.name === "edit" && (tone === "success" || tone === "error")) {
        const bg = tone === "success" ? "toolSuccessBg" : "toolErrorBg";
        const padding = " ".repeat(Math.max(0, room - kit.visibleWidth(part)));
        return indent + theme.style(lead + part + padding, { bg });
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
    return selected.map((item) => paint(item, digits));
  };

  // A notice counts against the budget: total body rows never exceed it.
  const show = Math.min(budget, diff ? diffRows.length : lines.length);
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
  // Still over: a single line alone outgrows the budget. Notices keep their row.
  let room = budget - selected.filter((item) => item.notice).length;
  const rows = items.flatMap((item, index) => {
    if (selected[index]?.notice) return item;
    const kept = clipRows(kit, item, room, width, mark);
    room -= kept.length;
    return kept;
  });
  if (fileNote) {
    const label = `${omittedLinesLabel(fileNote, "below", api.glyphs)} in file`;
    rows.push(indent + kit.truncateToWidth(omissionStyle(theme, label), inner, mark));
  }
  if (wrap) return { rows, clipped };
  const shown = new Set(selected.flatMap((item) => (item.index === undefined ? [] : [item.index])));
  // The file note hides lines no click can show; only a notice among the selected lines opens.
  const omission = selected.findIndex((item) => item.notice);
  return {
    rows,
    clipped,
    bar: previewBar(diff ? diffRows.length : lines.length, shown, rows.length),
    // One row per selected line, then the file note: a preview never wraps.
    sources: [...selected.map((item) => (item.notice ? undefined : item.index)), ...(fileNote ? [undefined] : [])],
    ...(omission === -1 ? {} : { omission }),
  };
}

/** The header, an opened command's continuation rows, and the body: one row budget for all. */
export function toolRowLayout(api: RenderApi, input: ToolRowInput, width: number): BodyLayout {
  const { line, continuation } = toolHeader(api, input, width);
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
              omissionStyle(api.theme, omittedLinesLabel(lines.length - (room - 1), "below", api.glyphs)),
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
