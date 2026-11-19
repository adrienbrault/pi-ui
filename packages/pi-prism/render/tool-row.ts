/**
 * Tool row: one header line plus a bounded body. The body budget is the whole
 * point: the closer a row is to the tail, the more of its output survives.
 */

import { bodyLinesFor, MAX_FULL_LINES, type DetailLevel } from "./detail.ts";
import { frameAt, type GlyphSet } from "./glyphs.ts";
import { blockBodyIndent, type ComponentLike, type RenderKit, type RenderTheme } from "./kit.ts";
import { cleanOutput, formatDuration, logicalLines, oneLine, omittedLinesLabel, MAX_FORMAT_CHARS } from "./text.ts";
import { describeCall, toolTokenCounts, toolMeta, toolTokenLabel, type TokenRates } from "./tools.ts";

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

/** Keep the opening and the end: a shell command's verb and target both matter. */
function truncateMiddle(kit: RenderKit, text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (kit.visibleWidth(text) <= width) return text;
  const chars = [...text];
  const room = width - kit.visibleWidth(ellipsis);
  if (room <= 0) return kit.truncateToWidth(ellipsis, width, ellipsis);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${chars.slice(0, head).join("")}${ellipsis}${tail > 0 ? chars.slice(-tail).join("") : ""}`;
}

/** Keep the end of a long path: the basename is the part a reader needs. */
function truncateLeft(kit: RenderKit, text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (kit.visibleWidth(text) <= width) return text;
  const chars = [...text];
  let kept = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const candidate = (chars[i] ?? "") + kept;
    if (kit.visibleWidth(candidate) + kit.visibleWidth(ellipsis) > width) break;
    kept = candidate;
  }
  return kept ? `${ellipsis}${kept}` : kit.truncateToWidth(text, width, ellipsis);
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

function styleMetric(theme: RenderTheme, label: string): string {
  return (label.match(/\d+(?:\.\d+)?k?|[a-z]+|[^a-z\d]+/gi) ?? [])
    .map((part) => {
      if (/^\d/.test(part)) return theme.fg("text", part);
      if (part === "out") return theme.fg("syntaxKeyword", part);
      if (part === "in") return theme.fg("syntaxType", part);
      return theme.fg("muted", part);
    })
    .join("");
}

export function toolHeader(api: RenderApi, input: ToolRowInput, width: number) {
  const { theme, glyphs, kit } = api;
  const meta = toolMeta(input.name);
  // Names, titles, summaries and errors come from the model or the tool: never trust them.
  const label = oneLine(meta.label);
  const title = oneLine(input.title ?? describeCall(input.name, input.args).title);
  const summary = input.summary === undefined ? undefined : oneLine(input.summary);
  const { outputTokens, inputTokens } = toolTokenCounts(input);
  const tokens = toolTokenLabel(outputTokens, inputTokens, input);

  const sep = ` ${theme.fg("dim", glyphs.dot)} `;
  // The verb is the headline: bold it through `style` so it survives headless
  // rendering, where chalk's bold turns itself off without a terminal.
  const prefix = `${statusGlyph(api, input)} ${theme.style(label, { fg: "toolTitle", bold: true })}`;

  let pieces: HeaderPiece[] = [];
  // MCP labels already read `server/tool`; repeating it as the title is noise.
  if (title && title !== label) pieces.push({ kind: "title", text: theme.fg("accent", title) });
  if (summary) pieces.push({ kind: "summary", text: theme.fg("dim", summary) });
  pieces.push({ kind: "tokens", text: styleMetric(theme, tokens) });
  const error = errorHeadline(input, meta);
  if (error) pieces.push({ kind: "error", text: theme.fg("error", error) });
  const duration = input.durationMs === undefined ? undefined : styleMetric(theme, formatDuration(input.durationMs));
  if (duration) pieces.push({ kind: "duration", text: duration });

  const compose = (parts: HeaderPiece[]) => parts.reduce((acc, part) => `${acc}${sep}${part.text}`, prefix);

  // Reserve space for the running shell clock if even a shortened command fits beside it.
  const keepClock = duration && kit.visibleWidth(prefix + sep + "…" + sep + duration) <= width;
  // Keep a readable portion of the command or path when fitting the metadata.
  const minimumWidth = (parts: HeaderPiece[]) =>
    kit.visibleWidth(
      compose(
        parts.map((piece) =>
          piece.kind === "title"
            ? { ...piece, text: kit.truncateToWidth(title, input.inputRate || input.outputRate ? 8 : 20, "…") }
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

  let truncated = false;
  if (kit.visibleWidth(compose(pieces)) > width) {
    const titlePiece = pieces.find((piece) => piece.kind === "title");
    if (titlePiece) {
      const others = pieces.filter((piece) => piece !== titlePiece);
      const room = width - kit.visibleWidth(compose(others)) - kit.visibleWidth(sep);
      const truncate = meta.cls === "shell" ? truncateMiddle : truncateLeft;
      const fitted = truncate(kit, title, room);
      truncated = fitted !== title;
      titlePiece.text = theme.fg("accent", fitted);
    }
  }

  const metrics = pieces.filter((part) => part.kind === "tokens" || part.kind === "duration");
  const command = input.name === "bash" ? cleanOutput(String(input.args?.command ?? title)) : "";
  const hiddenCommand = command && (truncated || command !== title) ? command : undefined;
  if (!metrics.length) return { line: kit.truncateToWidth(compose(pieces), width, "…"), hiddenCommand };
  const left = compose(pieces.filter((part) => !metrics.includes(part))) + sep;
  const right = metrics.map((part) => part.text).join(sep);
  const line = kit.truncateToWidth(
    left + " ".repeat(Math.max(0, width - kit.visibleWidth(left + right))) + right,
    width,
    "…",
  );
  return { line, hiddenCommand };
}

interface Selected {
  line: string;
  /** A notice row rather than a body row. */
  notice?: boolean;
  styled?: string;
}

/** Diff metadata and unchanged context are the first rows to go. */
const DIFF_NOISE = /^(diff --git|index |new file|deleted file|similarity |rename |--- |\+\+\+ )/;
const isDiffContext = (line: string): boolean => DIFF_NOISE.test(line) || line.startsWith(" ");

const notice = (count: number): Selected => ({ line: omittedLinesLabel(count), notice: true });

/**
 * Diffs keep what changed. Before hiding any hunk, drop the unchanged context
 * lines: the +/- rows carry the evidence, context is what a reader can infer.
 */
function selectDiff(lines: Selected[], show: number): Selected[] {
  if (lines.length <= show) return lines;

  const essential = lines.filter(({ line }) => !isDiffContext(line));
  const contextHidden = lines.length - essential.length;
  if (essential.length + 1 <= show) {
    return [...essential, notice(contextHidden)];
  }

  // Still too long: read the evidence in order, and say how much is left.
  const kept = show - 1;
  const hidden = lines.length - kept;
  return [...essential.slice(0, kept), notice(hidden)];
}

/** Reads keep their opening and their end; the notice marks the cut between them. */
function selectHead(lines: string[], show: number): Selected[] {
  if (lines.length <= show) return lines.map((line) => ({ line }));
  const room = show - 1;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  const hidden = lines.length - head - tail;
  // `slice(-0)` is `slice(0)`: a zero tail would spill the whole file.
  const keptTail = tail > 0 ? lines.slice(-tail) : [];
  return [...lines.slice(0, head).map((line) => ({ line })), notice(hidden), ...keptTail.map((line) => ({ line }))];
}

/** Logs keep the end: the last line is the one that explains the run. */
function selectTail(lines: string[], show: number): Selected[] {
  if (lines.length <= show) return lines.map((line) => ({ line }));
  if (show === 1) {
    const useful = lines.findLast((line) => {
      const text = cleanOutput(line).trim();
      return /^.{2}/u.test(text) && !/^[\s()[\]{},;]+$/u.test(text);
    });
    return useful ? [{ line: useful }] : [notice(lines.length)];
  }
  const kept = show - 1;
  return [...lines.slice(-kept).map((line) => ({ line })), notice(lines.length - kept)];
}

const DIFF_HINT = /^(diff --git|@@ )/m;

// Only recognise commands whose stdout is a single literal file or range of that file.
const SHELL_FILE =
  /^(?:cd\s+[\w./~-]+\s*&&\s*)?(?:cat(?:\s+--)?|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?)\s+(?:"([\w./ ~-]+)"|'([\w./ ~-]+)'|([\w./~-]+))\s*$/u;

function outputLanguage(input: ToolRowInput, text: string, kit: RenderKit): string | undefined {
  if (input.name === "read" || input.name === "write" || input.name === "edit") {
    const path = input.args?.path ?? input.args?.file_path ?? input.title;
    return typeof path === "string" ? kit.languageFromPath?.(path) : undefined;
  }
  if (input.name === "bash" && typeof input.args?.command === "string") {
    const match = SHELL_FILE.exec(input.args.command);
    if (match) return kit.languageFromPath?.(match[1] ?? match[2] ?? match[3]!);
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

/** Highlight each side of a hunk independently so removed syntax cannot bleed into additions. */
function editDiffRows(api: RenderApi, lines: string[], language?: string): Selected[] {
  const rows = lines.map((line): Selected => ({ line }));
  const highlight = api.kit.highlight;
  if (!language || !highlight) return rows;
  const numbered = !lines.some((line) => line.startsWith("@@ "));
  const prefix = numbered ? /^[ +-] *\d+ / : /^[ +-]/;
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
        row.styled = row.line.match(prefix)![0] + (styled[index] ?? row.line.replace(prefix, ""));
      });
    }
    start = end - 1;
  }
  return rows;
}

export function previewText(input: Pick<ToolRowInput, "name" | "args" | "output" | "error">): string {
  if (input.name === "write" && !input.error && typeof input.args?.content === "string" && input.args.content.length) {
    return input.args.content;
  }
  return input.output ?? "";
}

function body(api: RenderApi, input: ToolRowInput, width: number): string[] {
  const { theme, kit } = api;
  // A "full" read is allowed to be long, just not unbounded.
  const budget = input.full ? MAX_FULL_LINES : bodyLinesFor(input.level, input.expanded ?? false);
  if (budget <= 0) return [];

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
  const lines = source.flatMap((line, index) => (line.trim() ? [styledSource?.[index] ?? line] : []));
  if (lines.length === 0) return [];

  // A notice counts against the budget: total body rows never exceed it.
  const show = Math.min(budget, lines.length);
  const streamingWrite = input.name === "write" && input.status === "pending" && !input.expanded;
  const select = streamingWrite || meta.trend === "tail" ? selectTail : selectHead;
  const selected = diff
    ? selectDiff(
        editDiffRows(api, source, language).filter(({ line }) => line.trim()),
        show,
      )
    : select(lines, show);

  const indent = blockBodyIndent(width);
  return selected.map(({ line, styled, notice: isNotice }) => {
    const content = kit.truncateToWidth(styled ?? line, Math.max(1, width - indent.length), "…");
    if (isNotice) return indent + theme.fg("dim", content);
    const tone = diff ? diffTone(line) : undefined;
    if (diff && input.name === "edit" && (tone === "success" || tone === "error")) {
      const bg = tone === "success" ? "toolSuccessBg" : "toolErrorBg";
      const padding = " ".repeat(Math.max(0, width - indent.length - kit.visibleWidth(content)));
      return indent + theme.style(content + padding, { bg });
    }
    return indent + (tone ? theme.fg(tone, content) : theme.fg("toolOutput", content));
  });
}

export function renderToolRow(api: RenderApi, input: ToolRowInput): ComponentLike {
  return api.kit.component((width) => {
    const { line, hiddenCommand } = toolHeader(api, input, width);
    const rows = [line];
    if ((input.expanded || input.full) && hiddenCommand) {
      const indent = blockBodyIndent(width);
      for (const source of hiddenCommand.split("\n")) {
        for (const part of api.kit.wrap(source, Math.max(1, width - indent.length))) {
          rows.push(indent + api.theme.fg("accent", part));
        }
      }
    }
    return rows.concat(body(api, input, width));
  });
}

/** One collapsed row, no body: the aged 3 form. */
export function renderToolLine(api: RenderApi, input: ToolRowInput): ComponentLike {
  return api.kit.component((width) => [toolHeader(api, input, width).line]);
}
