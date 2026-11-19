import { describe, expect, test } from "bun:test";
import type { RenderKit } from "./kit.ts";
import { truncateMiddle } from "./tool-row.ts";

/** A kit that measures like a terminal: wide characters take two columns. */
const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") => {
    if (Bun.stringWidth(line) <= width) return line;
    let kept = "";
    for (const char of line) {
      if (Bun.stringWidth(kept + char) + Bun.stringWidth(ellipsis) > width) break;
      kept += char;
    }
    return kept + ellipsis;
  },
  wrap: (text, width) => text.split("\n").flatMap((line) => line.match(new RegExp(`.{1,${width}}`, "gu")) ?? [""]),
  visibleWidth: (text) => Bun.stringWidth(text),
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
};

describe("middle truncation", () => {
  test("wide characters are measured in columns, keeping both ends", () => {
    const text = "测试中文字符串一二三四五六七八九十结尾";
    for (const width of [10, 11, 16]) {
      const { text: cut } = truncateMiddle(kit, text, width, "…", (part) => part);
      expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(width);
      expect(cut.startsWith("测")).toBe(true);
      expect(cut.endsWith("尾")).toBe(true);
    }
  });

  test("a grapheme cluster is never split", () => {
    const family = "👨‍👩‍👧";
    const { text: cut } = truncateMiddle(kit, `${family}${"a".repeat(30)}${family}`, 12, "…", (part) => part);
    expect(cut.startsWith(family)).toBe(true);
    expect(cut.endsWith(family)).toBe(true);
  });
});
