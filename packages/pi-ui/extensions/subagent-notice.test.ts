import { describe, expect, test } from "bun:test";
import { glyphsFor } from "../render/glyphs.ts";
import type { RenderKit, RenderTheme } from "../render/kit.ts";
import { completionRuns, installSubagentNotice, noticeLines, noticeTitle, statusMark } from "./subagent-notice.ts";

/** Plain-text stand-ins: the assertions are about rows and words, not styling. */
const kit: RenderKit = {
  truncateToWidth: (line, width, ellipsis = "…") =>
    line.length <= width ? line : line.slice(0, Math.max(1, width - ellipsis.length)) + ellipsis,
  wrap: (text) => [text],
  visibleWidth: (text) => text.length,
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
};

const theme: RenderTheme = {
  fg: (_token, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  style: (text) => text,
};

const ANSWER = ["Moved the panel's widths into columns.ts.", "Updated the three cards that read them.", "Tests pass."];
const message = (details: unknown, content = ANSWER.join("\n")) => ({ content, details });

describe("subagent completion notices", () => {
  test("a run's own report names it and how it ended", () => {
    expect(completionRuns({ runs: [{ agent: "worker", status: "completed" }] })).toEqual([
      { agent: "worker", status: "completed" },
    ]);
    expect(completionRuns({ runs: [{ agent: "worker" }, { status: "completed" }] })).toBeUndefined();
    expect(completionRuns({ runs: [] })).toBeUndefined();
    expect(completionRuns(undefined)).toBeUndefined();
    expect(noticeTitle([{ agent: "scout", status: "completed" }])).toEqual({ title: "scout", status: "completed" });
    expect(
      noticeTitle([
        { agent: "a", status: "completed" },
        { agent: "b", status: "completed" },
      ]),
    ).toEqual({ title: "2 background runs", status: "completed" });
    expect(
      noticeTitle([
        { agent: "a", status: "completed" },
        { agent: "b", status: "failed" },
        { agent: "c", status: "stopped" },
      ]),
    ).toEqual({ title: "3 background runs finished", status: "1 failed · 1 stopped" });
    expect(statusMark("completed")).toEqual({ glyph: glyphsFor("unicode").done, token: "success" });
    expect(statusMark("failed")).toEqual({ glyph: glyphsFor("unicode").error, token: "error" });
    expect(statusMark("stopped")).toEqual({ glyph: glyphsFor("unicode").success, token: "warning" });
  });

  test("closed, the notice previews the answer and counts the rest", () => {
    const rows = noticeLines(kit, theme, message({ runs: [{ agent: "worker", status: "completed" }] }), 80, false);
    expect(rows[0]).toBe("✓ subagent · worker completed");
    expect(rows.slice(1)).toEqual([
      "    Moved the panel's widths into columns.ts.",
      "    Updated the three cards that read them.",
      "    Tests pass.",
    ]);
    const long = noticeLines(
      kit,
      theme,
      message({ runs: [{ agent: "worker", status: "completed" }] }, [...ANSWER, "line 4", "line 5"].join("\n")),
      80,
      false,
    );
    expect(long.slice(1)).toEqual([
      "    Moved the panel's widths into columns.ts.",
      "    Updated the three cards that read them.",
      "    Tests pass.",
      "    line 4",
      "    ↓ 1 more line",
    ]);
  });

  test("opened, every row the answer has shows", () => {
    const long = noticeLines(
      kit,
      theme,
      message({ runs: [{ agent: "worker", status: "completed" }] }, [...ANSWER, "line 4", "line 5"].join("\n")),
      80,
      true,
    );
    expect(long.length).toBe(6);
    expect(long.at(-1)).toBe("    line 5");
  });

  test("a failed run crosses, and several runs count themselves", () => {
    expect(
      noticeLines(kit, theme, message({ runs: [{ agent: "worker", status: "failed" }] }, "boom"), 80, false)[0],
    ).toBe("✗ subagent · worker failed");
    expect(
      noticeLines(
        kit,
        theme,
        message({
          runs: [
            { agent: "a", status: "completed" },
            { agent: "b", status: "completed" },
          ],
        }),
        80,
        false,
      )[0],
    ).toBe("✓ subagent · 2 background runs completed");
  });

  test("the three completion types are claimed, and nothing else", () => {
    const claimed: string[] = [];
    const pi = {
      registerMessageRenderer: (type: string) => {
        claimed.push(type);
      },
    };
    installSubagentNotice(pi as never);
    expect(claimed).toEqual(["subagent-notify", "subagent-completion-unanswered", "subagent-completion-unhandled"]);
    // pi without custom message renderers keeps pi-subagents' own blocks.
    expect(() => installSubagentNotice({} as never)).not.toThrow();
  });
});
