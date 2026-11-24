/**
 * The last prompt, pinned: one row at the top of the transcript while the prompt itself has
 * scrolled out of it.
 *
 * Not a second reading of the prompt — the pinned row only exists when the transcript no longer
 * shows the user message it repeats. It is that same object, in the same vocabulary: the marker
 * where a prompt starts, the prompt's opening text, and the neutral band the submitted prompt sits
 * on. A prompt too long for one row keeps its opening and ends on the cut mark.
 *
 * Pure: the session decides when the row exists; this decides what it says, and where the prompt
 * has to be for it to say anything.
 */

import { PROMPT_BG, type RenderKit, type RenderTheme } from "./kit.ts";
import type { GlyphSet } from "./glyphs.ts";
import { oneLine } from "./text.ts";

export interface PromptPinApi {
  kit: RenderKit;
  theme: RenderTheme;
  glyphs: GlyphSet;
}

export interface PromptPinInput {
  /** The prompt as it was sent: its text blocks, in order. */
  text: string;
  width: number;
}

/** The columns before the prompt text: the marker and the one space after it. */
export function promptPinMark(glyphs: GlyphSet): number {
  return glyphs.prompt.length + 1;
}

/** The cut mark's three columns, painted on the band: a cut keeps the band under it too. */
const MARK = " … ";
const MARK_COLUMNS = MARK.length;

/** One row: `❯ the prompt…` on the prompt band, padded to the pane, cut at its end. */
export function renderPinnedPrompt(api: PromptPinApi, input: PromptPinInput): string[] {
  const { kit, theme, glyphs } = api;
  const width = Math.max(1, input.width);
  const band = (text: string, fg: string, bold = false): string =>
    theme.style(text, { fg, bg: PROMPT_BG, ...(bold ? { bold: true } : {}) });
  // The gap after the marker is on the band: a run resets its background, so it cannot be plain.
  const marker = band(`${glyphs.prompt} `, "accent");
  const room = width - promptPinMark(glyphs);
  // No room for the mark and its own three columns: the marker alone, cut, rather than overflow.
  if (room <= MARK_COLUMNS) return [kit.truncateToWidth(marker, width)];
  const raw = oneLine(input.text);
  const cut = kit.visibleWidth(raw) > room;
  const shown = cut ? kit.truncateToWidth(raw, Math.max(0, room - MARK_COLUMNS), "") : raw;
  const body = band(shown, "text") + (cut ? band(MARK, "text", true) : "");
  const taken = promptPinMark(glyphs) + kit.visibleWidth(shown) + (cut ? MARK_COLUMNS : 0);
  const pad = Math.max(0, width - taken);
  return [`${marker}${body}${theme.style(" ".repeat(pad), { bg: PROMPT_BG })}`];
}

export interface PromptViewport {
  /** Rows the transcript shows at once. */
  viewportHeight: number;
  /** Rows of transcript content, header and spacers included. */
  contentHeight: number;
  /** The first content row on screen. */
  scrollTop: number;
  /** Whether the transcript is pinned to its end, as it is whenever no one has scrolled up. */
  followingEnd: boolean;
  /** Index of the prompt's last content row, 0-based; -1 when the prompt is not in the content. */
  promptEndRow: number;
}

/**
 * Whether the prompt has left the transcript above its viewport. Following the end, the pane shows
 * the content's last rows, so the prompt is above once its last row comes before the first visible
 * one; scrolled back, that same row against the offset says it directly. A prompt whose last row is
 * the first visible one has not left yet.
 */
export function promptAboveViewport(input: PromptViewport): boolean {
  if (input.viewportHeight <= 0 || input.contentHeight <= 0 || input.promptEndRow < 0) return false;
  if (input.followingEnd) return input.promptEndRow < input.contentHeight - input.viewportHeight;
  return input.promptEndRow < input.scrollTop;
}
