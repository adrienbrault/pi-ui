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

/**
 * OSC 8 hyperlinks are invisible to pi's HTML exporter, which would render the
 * escape sequence as text. Convert them to anchors instead, carrying the active
 * SGR state across link boundaries so a styled link keeps its colour.
 */
function lineToHtml(pi: PiInstall, raw: string): string {
  const line = raw.replace(OSC133, "");
  const { ansiToHtml } = pi.modules.exportHtml;

  const chunks: string[] = [];
  let segment = "";
  let href: string | undefined;
  let sgr = "";
  let index = 0;

  const flush = () => {
    if (!segment) return;
    const html = ansiToHtml(segment);
    chunks.push(href ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${html}</a>` : html);
    segment = "";
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
      index += sequence.length;
      continue;
    }

    segment += line[index];
    index += 1;
  }

  flush();
  return chunks.join("");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toHtml(pi: PiInstall, lines: string[]): string {
  return lines.map((line) => `<div class="ansi-line">${lineToHtml(pi, line) || "&nbsp;"}</div>`).join("");
}

/** Concatenate rendered components into one transcript-like stack. */
export function stack(width: number, components: Array<{ render(width: number): string[] }>): string[] {
  const lines: string[] = [];
  for (const component of components) lines.push(...component.render(width));
  return lines;
}
