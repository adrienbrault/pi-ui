/**
 * pi-subagents' completion notices, in pi-ui's vocabulary.
 *
 * A background run returns long after the call that launched it: the call's row says what it was
 * asked, and this block says what the child answered. pi-subagents registers its own renderers for
 * its custom messages; this takes the three that report a finished run and leaves the rest — a
 * request for a decision, a steering notice, a watchdog warning — to their own blocks.
 */

import { MouseRegion, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { glyphsFor } from "../render/glyphs.ts";
import { blockBodyIndent, omissionStyle, type RenderKit, type RenderTheme } from "../render/kit.ts";
import { cleanOutput, logicalLines, omittedLinesLabel } from "../render/text.ts";
import { KIT } from "./kit.ts";

/** The custom message types pi-subagents sends when a background run comes back. */
export const COMPLETION_TYPES = [
  "subagent-notify",
  "subagent-completion-unanswered",
  "subagent-completion-unhandled",
] as const;

/** Rows a closed notice previews: the answer's opening, and a notice counting the rest. */
const PREVIEW_ROWS = 4;

const GLYPHS = glyphsFor("unicode");

/** A custom message, as far as a completion notice reads it. */
export interface NoticeMessage {
  content?: unknown;
  details?: unknown;
}

/** One finished run a notice reports: who ran, and how it ended. */
export interface NoticeRun {
  agent: string;
  status: string;
}

/** Every run a notice's `details.runs` reports, in order; undefined when it reports none. */
export function completionRuns(details: unknown): NoticeRun[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const runs = (details as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return undefined;
  const read = runs.flatMap((entry): NoticeRun[] => {
    if (!entry || typeof entry !== "object") return [];
    const run = entry as { agent?: unknown; status?: unknown };
    if (typeof run.agent !== "string" || typeof run.status !== "string") return [];
    return [{ agent: run.agent, status: run.status }];
  });
  return read.length === runs.length && read.length ? read : undefined;
}

/** A message's text, whatever shape pi hands it in. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/** The glyph and the token a run's status is drawn with: a check, a cross, a stopped square. */
export function statusMark(status: string): { glyph: string; token: "success" | "error" | "warning" | "dim" } {
  switch (status) {
    case "completed":
      return { glyph: GLYPHS.done, token: "success" };
    case "failed":
      return { glyph: GLYPHS.error, token: "error" };
    case "paused":
    case "stopped":
    case "detached":
      return { glyph: GLYPHS.success, token: "warning" };
    default:
      return { glyph: GLYPHS.pending, token: "dim" };
  }
}

/** The words a notice's title carries: the child's name, or how many runs came back. */
export function noticeTitle(runs: NoticeRun[] | undefined): { title: string; status: string } {
  if (!runs?.length) return { title: "background run", status: "finished" };
  if (runs.length === 1) return { title: runs[0]!.agent, status: runs[0]!.status };
  const everyOne = runs.every((run) => run.status === "completed");
  if (everyOne) return { title: `${runs.length} background runs`, status: "completed" };
  const counts = ["failed", "paused", "stopped"].flatMap((status) => {
    const count = runs.filter((run) => run.status === status).length;
    return count ? [`${count} ${status}`] : [];
  });
  return { title: `${runs.length} background runs finished`, status: counts.join(" · ") };
}

/**
 * A completion notice's rows: its title, then the answer the child came back with. Closed, it
 * previews the answer's first rows and counts the rest; opened — by a click, or pi's expand key —
 * it shows every row.
 */
export function noticeLines(
  kit: RenderKit,
  theme: RenderTheme,
  message: NoticeMessage,
  width: number,
  expanded: boolean,
): string[] {
  const runs = completionRuns(message.details);
  const { title, status } = noticeTitle(runs);
  const mark = statusMark(runs?.length === 1 ? runs[0]!.status : (status.split(" ")[0] ?? ""));
  const header = `${theme.fg(mark.token, mark.glyph)} ${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg(
    "dim",
    GLYPHS.dot,
  )} ${theme.fg("text", title)} ${theme.fg(mark.token, status)}`;
  const text = cleanOutput(messageText(message.content));
  const lines = logicalLines(text).filter((line) => line.trim());
  const indent = blockBodyIndent(width);
  const inner = Math.max(1, width - indent.length);
  const body = lines.map((line) => indent + kit.truncateToWidth(line, inner, theme.bold(" … ")));
  if (expanded || body.length <= PREVIEW_ROWS) return [kit.truncateToWidth(header, width, theme.bold(" … ")), ...body];
  const shown = body.slice(0, PREVIEW_ROWS);
  const hidden = lines.length - PREVIEW_ROWS;
  const notice = indent + omissionStyle(theme, omittedLinesLabel(hidden, "below", GLYPHS));
  return [kit.truncateToWidth(header, width, theme.bold(" … ")), ...shown, notice];
}

/** Whether the pointer opened this notice; pi's expand key is the other way in. */
const clicked = new WeakMap<object, boolean>();

function noticeComponent(message: NoticeMessage, expandedByPi: boolean, theme: RenderTheme): Component {
  const inner = {
    render: (width: number) =>
      noticeLines(KIT, theme, message, width, expandedByPi || clicked.get(message as object) === true),
    invalidate: () => {},
  };
  return new MouseRegion(inner, (event: TuiMouseEvent) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    clicked.set(message as object, !(expandedByPi || clicked.get(message as object) === true));
    return { handled: true, render: true } as const;
  });
}

export function installSubagentNotice(pi: ExtensionAPI): void {
  const register = (pi as { registerMessageRenderer?: unknown }).registerMessageRenderer;
  // pi without custom message renderers keeps pi-subagents' own blocks.
  if (typeof register !== "function") return;
  for (const type of COMPLETION_TYPES)
    (register as (type: string, renderer: unknown) => void).call(
      pi,
      type,
      (message: NoticeMessage, options: { expanded?: boolean }, theme: RenderTheme) =>
        noticeComponent(message, options.expanded === true, theme),
    );
}
