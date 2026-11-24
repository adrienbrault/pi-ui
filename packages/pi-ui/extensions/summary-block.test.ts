import { describe, expect, test } from "bun:test";
import { glyphsFor } from "../render/glyphs.ts";
import type { RenderKit, RenderTheme } from "../render/kit.ts";
import { compactSummaryBlock, isSummaryComponent } from "./summary-block.ts";

const kit: RenderKit = {
  truncateToWidth: (line, width) => (line.length <= width ? line : line.slice(0, width)),
  wrap: (text) => text.split("\n"),
  visibleWidth: (text) => text.length,
  component: (build) => ({ render: (width) => build(width), invalidate: () => {} }),
};

/** Which token painted each run, so a test can say what a hover lit. */
const painted = new Map<string, string>();
const theme: RenderTheme = {
  fg: (name, text) => {
    painted.set(text, name);
    return text;
  },
  bold: (text) => text,
  italic: (text) => text,
  style: (text) => text,
};

const api = { kit, theme, glyphs: glyphsFor("unicode") };

/** pi's summary component, duck-typed: a message, an expand state and a layout it rebuilds. */
class FakeSummary {
  message: { role: string; summary: string; tokensBefore?: number };
  expanded = false;
  renders = 0;
  layouts = 0;
  invalidations = 0;
  /** pi's components have none until the patch installs one. */
  handleMouse?: (event: { type?: string; button?: string }) => unknown;

  constructor(message: { role: string; summary: string; tokensBefore?: number }) {
    this.message = message;
    this.updateDisplay();
  }

  render(width: number): string[] {
    this.renders++;
    return [`band ${width}`];
  }

  invalidate(): void {
    this.invalidations++;
    this.updateDisplay();
  }

  updateDisplay(): void {
    this.layouts++;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateDisplay();
  }
}

const LONG = "- one\n- two\n- three\n- four";

describe("summary components", () => {
  test("only pi's two summary roles are claimed", () => {
    expect(isSummaryComponent(new FakeSummary({ role: "compactionSummary", summary: LONG, tokensBefore: 100 }))).toBe(
      true,
    );
    expect(isSummaryComponent(new FakeSummary({ role: "branchSummary", summary: LONG }))).toBe(true);
    expect(isSummaryComponent({ message: { role: "user" }, expanded: false })).toBe(false);
    expect(isSummaryComponent({ message: { role: "compactionSummary" } })).toBe(false);
    expect(isSummaryComponent(undefined)).toBe(false);
  });

  test("the patch replaces pi's band and never rebuilds its children again", () => {
    const component = new FakeSummary({ role: "compactionSummary", summary: LONG, tokensBefore: 128_412 });
    compactSummaryBlock(component, api);
    expect(component.render(80)).not.toEqual(["band 80"]);
    expect(component.render(80)[0]).toBe("▸ compaction · 128.4k tokens");
    expect(component.layouts).toBe(1);
    component.invalidate();
    component.setExpanded(true);
    expect(component.layouts).toBe(1);
    expect(component.expanded).toBe(true);
  });

  test("a click opens a summary with rows to reveal, and closes it again", () => {
    const component = new FakeSummary({ role: "branchSummary", summary: LONG });
    compactSummaryBlock(component, api);
    component.render(80);
    expect(component.handleMouse?.({ type: "click" })).toEqual({ handled: true, render: true });
    expect(component.expanded).toBe(true);
    expect(component.render(80).some((row) => row.includes("⋮"))).toBe(false);
    component.handleMouse?.({ type: "click" });
    expect(component.expanded).toBe(false);
    expect(component.render(80).some((row) => row.includes("⋮ 2 more lines"))).toBe(true);
  });

  test("a short summary is inert: a click changes nothing, and nothing lights", () => {
    const component = new FakeSummary({ role: "branchSummary", summary: "Done." });
    compactSummaryBlock(component, api);
    component.render(80);
    const result = component.handleMouse?.({ type: "click" }) as { handled?: boolean } | undefined;
    expect(result?.handled).toBe(true);
    expect(component.expanded).toBe(false);
  });

  test("a move lights the block, and the count reads in the text colour", () => {
    const component = new FakeSummary({ role: "compactionSummary", summary: LONG, tokensBefore: 128_412 });
    compactSummaryBlock(component, api);
    component.render(80);
    expect(component.handleMouse?.({ type: "move" })).toEqual({ handled: true, render: true });
    painted.clear();
    component.render(80);
    expect(painted.get("128.4k tokens")).toBe("text");
    painted.clear();
    component.handleMouse?.({ type: "move" });
    expect(painted.size).toBe(0); // a move changes state, not the theme
    // A second move over the same block changes no pixels, so no repaint is asked for.
    expect(component.handleMouse?.({ type: "move" })).toEqual({ handled: true, render: false });
  });

  test("a wheel event passes through: no hover, no claim", () => {
    const component = new FakeSummary({ role: "branchSummary", summary: LONG });
    compactSummaryBlock(component, api);
    component.render(80);
    expect(component.handleMouse?.({ type: "wheel" })).toBeUndefined();
  });

  test("patching twice only picks up a new theme", () => {
    const component = new FakeSummary({ role: "compactionSummary", summary: LONG, tokensBefore: 128_412 });
    compactSummaryBlock(component, api);
    const render = component.render;
    compactSummaryBlock(component, { ...api, glyphs: glyphsFor("ascii") });
    expect(component.render).toBe(render);
    expect(component.render(80)[0]).toBe("> compaction . 128.4k tokens");
  });
});
