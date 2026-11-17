import { describe, expect, test } from "bun:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import prism, { hintFor, nextExpansion } from "./index.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  style: (text: string) => text,
  colors: { accent: "accent", toolPendingBg: "bg" },
};

const ctx = {
  args: { command: "bun test" },
  state: undefined as unknown as { expansion: number; hover: boolean },
  isPartial: false,
  isError: false,
  executionStarted: true,
  durationMs: 8.7,
  invalidate: () => {},
};

const click = (): TuiMouseEvent => ({
  type: "click",
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 80,
  height: 10,
  shift: false,
  alt: false,
  ctrl: false,
});

const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
const result = { content: [{ type: "text", text: output }] };

interface Row {
  render(width: number): string[];
  handleMouse?(event: TuiMouseEvent): unknown;
}

interface Renderers {
  renderCall(args: unknown, theme: unknown, ctx: unknown): Row;
  renderResult(result: unknown, options: unknown, theme: unknown, ctx: unknown): Row;
}

function resolver(): (name: string, next: () => unknown) => Renderers | unknown {
  let captured: unknown;
  prism({
    registerToolRenderer: (r: unknown) => {
      captured = r;
    },
  } as never);
  return captured as (name: string, next: () => unknown) => Renderers | unknown;
}

describe("expansion cycle", () => {
  test("three states wrap", () => {
    expect([nextExpansion(0), nextExpansion(1), nextExpansion(2)]).toEqual([1, 2, 0]);
  });

  test("hints name the next action", () => {
    expect(hintFor(0, true)).toBe("click · expand");
    expect(hintFor(1, true)).toBe("click · show all");
    expect(hintFor(1, false)).toBe("click · collapse");
    expect(hintFor(2, true)).toBe("click · collapse");
  });
});

const move = (): TuiMouseEvent => ({ ...click(), type: "move", button: "none" });

describe("tool renderers", () => {
  test("leaves unowned tools to the next resolver", () => {
    const base = { renderShell: "default" };
    expect(resolver()("todo", () => base)).toBe(base);
  });

  test("body hover pins the chip on the header row", () => {
    const renderers = resolver()("bash", () => undefined) as Renderers;
    const header = renderers.renderCall(ctx.args, theme, ctx);
    const body = renderers.renderResult(result, {}, theme, ctx);

    expect(header.render(80)[0]).not.toContain("[ click");
    body.handleMouse?.(move());
    const line = header.render(80)[0] ?? "";
    expect(line).toContain("[ click · expand ]");
  });

  test("owned tools claim the row and grow the body on click", () => {
    const renderers = resolver()("bash", () => undefined) as Renderers;
    const header = renderers.renderCall(ctx.args, theme, ctx);
    const body = renderers.renderResult(result, {}, theme, ctx);

    expect(header.render(80)).toHaveLength(1);
    expect(body.render(80).length).toBeLessThan(16);

    // Click on the header twice: capped, then the whole output.
    header.handleMouse?.(click());
    const capped = body.render(80).length;
    header.handleMouse?.(click());
    const full = body.render(80).length;
    header.handleMouse?.(click());
    const back = body.render(80).length;

    expect(capped).toBeGreaterThan(0);
    expect(full).toBe(40);
    expect(back).toBeLessThan(capped);
  });
});
