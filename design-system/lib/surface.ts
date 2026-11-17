/** Render surface: component -> lines -> HTML, plus the injected RenderKit. */

import type { ComponentLike, RenderKit } from "../../packages/pi-prism/render/kit.ts";
import type { PiInstall } from "./pi.ts";

export function createKit(pi: PiInstall): RenderKit {
  const { truncateToWidth, visibleWidth } = pi.modules.tui;
  return {
    truncateToWidth: (line, width, ellipsis) => truncateToWidth(line, width, ellipsis),
    visibleWidth: (text) => visibleWidth(text),
    component: (build) =>
      ({
        render: (width: number) => build(width),
        invalidate: () => {},
      }) satisfies ComponentLike,
  };
}

export function renderLines(component: { render(width: number): string[] }, width: number): string[] {
  return component.render(Math.max(1, Math.floor(width)));
}

/** pi's shell integration markers; HTML has no equivalent, so drop them. */
// oxlint-disable-next-line no-control-regex -- shell-integration markers are escapes
const OSC133 = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex -- OSC 8 hyperlinks are escapes
const OSC8_OPEN = /\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/;
// oxlint-disable-next-line no-control-regex -- SGR sequences are escapes
const SGR = /^\x1b\[[0-9;:]*m/;

export interface RowPaint {
  html: string;
  /** Background covering the whole padded row, as the terminal would paint it. */
  background?: string;
}

/**
 * pi's tool boxes paint one background across a whole padded row. Inline spans
 * only cover the text box, so HTML would show unpainted gaps between lines.
 * Hoist a uniform row background onto the line element instead.
 */
function rowBackground(sequence: string): string | null | undefined {
  const params = sequence
    .slice(2, -1)
    .split(";")
    .map((part) => Number.parseInt(part === "" ? "0" : part, 10));
  for (let i = 0; i < params.length; i++) {
    const code = params[i] ?? 0;
    if (code === 0 || code === 49) return null;
    if (code === 48) {
      // 48;2;r;g;b is what pi's truecolour themes emit; 256-colour needs a
      // palette we do not carry, so leave those rows to the inline spans.
      if (params[i + 1] !== 2) return undefined;
      const rgb = [params[i + 2], params[i + 3], params[i + 4]];
      if (rgb.some((channel) => channel === undefined)) return undefined;
      return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    }
  }
  return undefined;
}

/**
 * OSC 8 hyperlinks are invisible to pi's HTML exporter, which would render the
 * escape sequence as text. Convert them to anchors instead, carrying the active
 * SGR state across link boundaries so a styled link keeps its colour.
 */
function lineToHtml(pi: PiInstall, raw: string): RowPaint {
  const line = raw.replace(OSC133, "");
  const { ansiToHtml } = pi.modules.exportHtml;

  const chunks: string[] = [];
  let segment = "";
  let href: string | undefined;
  let sgr = "";
  let index = 0;

  let background: string | undefined;
  let backgroundAtStart: string | undefined;
  let paintedGap = false;
  let printed = false;

  const flush = () => {
    if (!segment) return;
    const html = ansiToHtml(segment);
    chunks.push(href ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${html}</a>` : html);
    segment = "";
  };

  const paint = () => {
    if (!printed) {
      printed = true;
      backgroundAtStart = background;
    }
    if (!background) paintedGap = true;
  };

  while (index < line.length) {
    const rest = line.slice(index);

    const link = OSC8_OPEN.exec(rest);
    if (link && link.index === 0) {
      flush();
      href = link[1] || undefined;
      // A close sequence sets no URI; it ends the link.
      if (!link[1]) href = undefined;
      index += link[0].length;
      segment = sgr;
      continue;
    }

    const sgrMatch = SGR.exec(rest);
    if (sgrMatch) {
      const sequence = sgrMatch[0];
      sgr = sequence === "\x1b[0m" ? "" : sgr + sequence;
      segment += sequence;
      const next = rowBackground(sequence);
      if (next !== undefined) background = next ?? undefined;
      index += sequence.length;
      continue;
    }

    paint();
    segment += line[index];
    index += 1;
  }

  flush();
  const uniform = printed && !paintedGap && backgroundAtStart !== undefined;
  return uniform ? { html: chunks.join(""), background: backgroundAtStart } : { html: chunks.join("") };
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toRows(pi: PiInstall, lines: string[]): string[] {
  return lines.map((line) => {
    const row = lineToHtml(pi, line);
    const style = row.background ? ` style="background-color:${row.background}"` : "";
    return `<div class="ansi-line"${style}>${row.html || "&nbsp;"}</div>`;
  });
}

export function toHtml(pi: PiInstall, lines: string[]): string {
  return toRows(pi, lines).join("");
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
