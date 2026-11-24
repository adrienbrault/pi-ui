import { describe, expect, test } from "bun:test";
import { glyphsFor } from "./glyphs.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";
import { PROMPT_BG } from "./kit.ts";
import { promptAboveViewport, promptPinMark, renderPinnedPrompt } from "./pinned-prompt.ts";

const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") =>
    line.length <= width ? line : line.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis,
  wrap: (text) => text.split("\n"),
  visibleWidth: (text) => text.replace(/<\/?[^>]*>/g, "").length,
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
};

/** Every painted run says which token and band it took. */
const theme: RenderTheme = {
  fg: (token, text) => `<${token}>${text}</${token}>`,
  bold: (text) => `**${text}**`,
  italic: (text) => `_${text}_`,
  style: (text, options) => {
    const tags = [options.bg ? `bg:${options.bg}` : "", options.fg ?? "", options.bold ? "bold" : ""].filter(Boolean);
    return `<${tags.join("|")}>${text}</>`;
  },
};

const api = { kit, theme, glyphs: glyphsFor("unicode") };
const PROMPT = "Split the ladder's regressions out of the render tests, then say what still fails.";

describe("pinned prompt", () => {
  test("one row: the marker, the prompt, and the band all the way across", () => {
    const [row] = renderPinnedPrompt(api, { text: "Track the panel work.", width: 40 });
    expect(row).toContain(`<bg:${PROMPT_BG}|accent>❯ </>`);
    expect(row).toContain(`<bg:${PROMPT_BG}|text>Track the panel work.</>`);
    // The padding is banded too: the row is a band, not a label on it.
    expect(row).toMatch(new RegExp(`<bg:${PROMPT_BG}> +</>$`));
    expect(kit.visibleWidth(row as string)).toBe(40);
  });

  test("a prompt longer than the pane keeps its opening and ends on the cut mark", () => {
    const [row] = renderPinnedPrompt(api, { text: PROMPT, width: 40 });
    expect(row).toContain(`<bg:${PROMPT_BG}|text|bold> … </>`);
    expect(row).not.toContain("still fails.");
    expect(kit.visibleWidth(row as string)).toBe(40);
  });

  test("a prompt that just fits is not cut", () => {
    const text = "x".repeat(40 - promptPinMark(glyphsFor("unicode")));
    const [row] = renderPinnedPrompt(api, { text, width: 40 });
    expect(row).not.toContain(" … ");
    expect(kit.visibleWidth(row as string)).toBe(40);
  });

  test("a multi-line prompt reads as one row", () => {
    const [row] = renderPinnedPrompt(api, {
      text: "Review the fold planner.\n\n- keep failures\n- one summary",
      width: 60,
    });
    expect(row).toContain("Review the fold planner. - keep failures - one summary");
  });

  test("a pane narrower than the marker overflows nothing", () => {
    for (const width of [2, 3, 4, 5]) {
      const rows = renderPinnedPrompt(api, { text: PROMPT, width });
      expect(rows).toHaveLength(1);
      expect(kit.visibleWidth(rows[0] as string)).toBeLessThanOrEqual(width);
    }
  });

  test("an ASCII marker is one column wider than nothing", () => {
    expect(promptPinMark(glyphsFor("ascii"))).toBe(2);
    expect(promptPinMark(glyphsFor("unicode"))).toBe(2);
  });
});

describe("when the prompt has left the viewport", () => {
  // 100 content rows, a 20-row pane: following the end, row 80 is the first visible one.
  const base = { viewportHeight: 20, contentHeight: 100, scrollTop: 80, followingEnd: true };

  test("following the end: above once its last row comes before the first visible one", () => {
    expect(promptAboveViewport({ ...base, promptEndRow: 80 })).toBe(false); // its last row is the first visible one
    expect(promptAboveViewport({ ...base, promptEndRow: 79 })).toBe(true);
    expect(promptAboveViewport({ ...base, promptEndRow: 81 })).toBe(false);
  });

  test("scrolled back: the offset says whether the prompt's last row is still on screen", () => {
    const scrolled = { ...base, followingEnd: false };
    expect(promptAboveViewport({ ...scrolled, promptEndRow: 80 })).toBe(false);
    expect(promptAboveViewport({ ...scrolled, promptEndRow: 79, scrollTop: 80 })).toBe(true);
    // Read back above it, the prompt is below the pane, not above it.
    expect(promptAboveViewport({ ...scrolled, promptEndRow: 80, scrollTop: 10 })).toBe(false);
  });

  test("a transcript shorter than the pane pins nothing", () => {
    expect(
      promptAboveViewport({ viewportHeight: 20, contentHeight: 12, scrollTop: 0, followingEnd: true, promptEndRow: 5 }),
    ).toBe(false);
    expect(promptAboveViewport({ ...base, promptEndRow: 5, viewportHeight: 0 })).toBe(false);
    expect(promptAboveViewport({ ...base, promptEndRow: 5, contentHeight: 0 })).toBe(false);
  });

  test("a prompt that is not in the content pins nothing", () => {
    expect(promptAboveViewport({ ...base, promptEndRow: -1 })).toBe(false);
  });
});
