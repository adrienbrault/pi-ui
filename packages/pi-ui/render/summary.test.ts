import { describe, expect, test } from "bun:test";
import { glyphsFor } from "./glyphs.ts";
import type { RenderKit, RenderTheme } from "./kit.ts";
import { SUMMARY_CLOSED_ROWS, summaryHeader, summaryLayout } from "./summary.ts";
import { HEADER_MARGIN } from "./tools.ts";

function wrapPlain(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const source of text.split("\n")) {
    let rest = source;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) {
        rows.push(rest.slice(0, width));
        rest = rest.slice(width);
      } else {
        rows.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      }
    }
    rows.push(rest);
  }
  return rows;
}

const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") =>
    line.length <= width ? line : line.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis,
  wrap: wrapPlain,
  visibleWidth: (text) => text.length,
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
};

/** Plain-text stand-ins: row counts, widths and cuts measure the text, not the styling. */
const plain: RenderTheme = {
  fg: (_token, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  style: (text) => text,
};

/** Tags every painted run, so a test can say which token lit. */
const tagged: RenderTheme = {
  fg: (token, text) => `<${token}>${text}</${token}>`,
  bold: (text) => `**${text}**`,
  italic: (text) => `_${text}_`,
  style: (text, options) => `<${options.fg}>${options.bold ? `**${text}**` : text}</${options.fg}>`,
};

const api = { kit, theme: plain, glyphs: glyphsFor("unicode") };
const lit = { kit, theme: tagged, glyphs: glyphsFor("unicode") };

const SUMMARY = [
  "## Session so far",
  "",
  "**Done.** The todo panel, the ask block and the subagent rows.",
  "",
  "- hover lights any title",
  "- scripts put their calls in rows",
  "",
  "**Next.** Claim the summary blocks.",
].join("\n");

describe("summary header", () => {
  test("a compaction leads with its label and the count pi records", () => {
    expect(summaryHeader(lit, { kind: "compaction", summary: "", tokensBefore: 128_412, width: 200 })).toBe(
      "<accent>▸</accent> <toolTitle>**compaction**</toolTitle> <dim>·</dim> <accent>128.4k tokens</accent>",
    );
  });

  test("opening it turns the glyph; hovering lights the count, never the label", () => {
    const header = summaryHeader(lit, {
      kind: "compaction",
      summary: "",
      tokensBefore: 128_412,
      expanded: true,
      lit: true,
      width: 200,
    });
    expect(header).toContain("<accent>▾</accent>");
    expect(header).toContain("<toolTitle>**compaction**</toolTitle>");
    expect(header).toContain("<text>128.4k tokens</text>");
  });

  test("a branch summary has no count: pi's context message keeps only its text", () => {
    expect(summaryHeader(lit, { kind: "branch", summary: "", width: 200 })).toBe(
      "<accent>▸</accent> <toolTitle>**branch**</toolTitle>",
    );
  });

  test("a header is cut to the pane, not the pane minus nothing", () => {
    const header = summaryHeader(api, { kind: "compaction", summary: "", tokensBefore: 128_412, width: 20 });
    expect(header.length).toBeLessThanOrEqual(20 - HEADER_MARGIN);
  });
});

describe("summary body", () => {
  test("closed, it keeps the opening rows and counts every other one", () => {
    const { rows, canToggle } = summaryLayout(api, { kind: "compaction", summary: SUMMARY, width: 80 });
    expect(canToggle).toBe(true);
    expect(rows).toHaveLength(1 + SUMMARY_CLOSED_ROWS + 1);
    expect(rows[1]?.trim()).toBe("## Session so far");
    // A blank Markdown row carries no evidence: the preview skips it.
    expect(rows[2]?.trim()).toBe("**Done.** The todo panel, the ask block and the subagent rows.");
    expect(rows[3]).toContain("⋮ 3 more lines");
  });

  test("opened, it shows all of it and no notice", () => {
    const { rows, canToggle } = summaryLayout(api, { kind: "compaction", summary: SUMMARY, expanded: true, width: 80 });
    expect(canToggle).toBe(true);
    expect(rows.some((row) => row.includes("more lines"))).toBe(false);
    expect(rows.at(-1)?.trim()).toBe("**Next.** Claim the summary blocks.");
    expect(rows.length).toBeGreaterThan(1 + SUMMARY_CLOSED_ROWS);
  });

  test("every row starts one indent in and fits the pane", () => {
    for (const expanded of [false, true]) {
      const rows = summaryLayout(api, { kind: "compaction", summary: SUMMARY, expanded, width: 40 }).rows;
      for (const row of rows.slice(1)) {
        expect(row.startsWith("    ")).toBe(true);
        expect(kit.visibleWidth(row.replace(/<\/?[a-z]+>/g, ""))).toBeLessThanOrEqual(40);
      }
    }
  });

  test("a summary with nothing to reveal is inert: no notice, no click", () => {
    const { rows, canToggle } = summaryLayout(api, { kind: "branch", summary: "Short.\n", width: 80 });
    expect(canToggle).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.includes("more lines"))).toBe(false);
  });

  test("an empty summary is the header alone", () => {
    for (const summary of ["", "  \n\n "]) {
      expect(summaryLayout(api, { kind: "branch", summary, width: 80 })).toEqual({
        rows: [summaryHeader(api, { kind: "branch", summary, width: 80 })],
        canToggle: false,
      });
    }
  });

  test("a hover lights the notice of a block a click opens, and nothing else", () => {
    const { rows } = summaryLayout(lit, {
      kind: "compaction",
      summary: SUMMARY,
      tokensBefore: 128_412,
      lit: true,
      width: 200,
    });
    expect(rows[0]).toContain("<text>128.4k tokens</text>");
    expect(rows[3]).toContain("<text>⋮ 3 more lines</text>");
    const short = summaryLayout(lit, { kind: "branch", summary: "Short.", lit: true, width: 200 }).rows;
    expect(short[0]).not.toContain("<text>");
  });
});

describe("summary markdown", () => {
  test("the kit's parser is asked for plain text, not the thought's italic grey", () => {
    const asked: Array<{ source: string; style?: { token?: string; italic?: boolean } }> = [];
    const markdownKit: RenderKit = {
      ...kit,
      markdown: (source, _width, _theme, _owner, style) => {
        asked.push({ source, ...(style ? { style } : {}) });
        return ["parsed", "rows"];
      },
    };
    const owner = {};
    summaryLayout(
      { kit: markdownKit, theme: plain, glyphs: glyphsFor("unicode"), owner },
      {
        kind: "branch",
        summary: SUMMARY,
        width: 80,
      },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.source.trimEnd()).toBe(SUMMARY);
    expect(asked[0]?.style).toEqual({ token: "text", italic: false });
  });
});
