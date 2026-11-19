/**
 * Text hygiene for transcript tails. Model and shell output is untrusted: strip
 * terminal control sequences, keep the newest frame of a `\r` progress bar, and
 * bound how many logical lines we carry into a block.
 *
 * Dependency-free; width work is injected through RenderKit.
 */

/** Rich parsers handle ordinary pi read results (up to 50 KiB) and bounded thought bodies. */
export const MAX_FORMAT_CHARS = 64 * 1024;

// oxlint-disable-next-line no-control-regex -- escape sequences are the input domain
const ANSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\][^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b[@-Z\\_]/g;
// oxlint-disable-next-line no-control-regex -- C0/C1 controls are what we strip
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Drop escape sequences, keep text, and take the last `\r` frame of each line. */
export function cleanOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const withoutTrailingCr = line.replace(/\r+$/, "");
      return withoutTrailingCr.slice(withoutTrailingCr.lastIndexOf("\r") + 1);
    })
    .join("\n")
    .replace(CONTROL, "");
}

/** Reasoning text: clean it, then collapse runs of whitespace per line. */
export function cleanThinking(text: string): string {
  return cleanOutput(text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function logicalLines(text: string): string[] {
  return text ? text.split("\n") : [];
}

/** First `count` non-empty lines. */
export function headLines(text: string, count: number): string[] {
  const lines: string[] = [];
  for (const line of logicalLines(text)) {
    if (!line.trim()) continue;
    lines.push(line);
    if (lines.length >= count) break;
  }
  return lines;
}

/** Last `count` non-empty lines, in reading order. */
export function tailLines(text: string, count: number): string[] {
  if (count <= 0) return [];
  const all = logicalLines(text);
  const lines: string[] = [];
  for (let i = all.length - 1; i >= 0 && lines.length < count; i--) {
    const line = all[i];
    if (line === undefined || !line.trim()) continue;
    lines.push(line);
  }
  return lines.toReversed();
}

export function omittedLinesLabel(count: number): string {
  return `+ ${count} ${count === 1 ? "line" : "lines"}`;
}

/** Hidden count above a tail (or below a head) so the reader knows what is gone. */
export function omittedCount(text: string, shown: number): number {
  return Math.max(0, nonEmptyLineCount(text) - shown);
}

/** Non-empty logical lines in a block. */
export function nonEmptyLineCount(text: string): number {
  return logicalLines(text).filter((line) => line.trim()).length;
}

/**
 * Collapse a block into one line for the `aged 3` form: keep the most
 * informative chunk and make it fit a width budget.
 */
export function squeeze(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Use millisecond resolution for short operations and compact seconds for longer spans. */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 1) return "<1ms";
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
