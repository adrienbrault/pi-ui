import { describe, expect, test } from "bun:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import prism, { actionFor, hintFor } from "./index.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  bg: (_token: string, text: string) => text,
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
    on: () => () => {},
  } as never);
  return captured as (name: string, next: () => unknown) => Renderers | unknown;
}

describe("expansion cycle", () => {
  test("nothing to reveal means no step", () => {
    expect(actionFor(0, 4)).toBeNull();
    expect(hintFor(0, 4)).toBeNull();
  });

  test("hints name the next action", () => {
    expect(hintFor(0, 40)).toBe("click · expand");
    expect(hintFor(1, 40)).toBe("click · show all");
    expect(hintFor(1, 12)).toBe("click · collapse");
    expect(hintFor(2, 40)).toBe("click · collapse");
  });

  test("clicks follow the action, not a blind cycle", () => {
    expect(actionFor(0, 40)).toBe(1);
    expect(actionFor(1, 12)).toBe(0);
    expect(actionFor(2, 12)).toBe(0);
  });

  test("an aged row only expands past its own budget", () => {
    expect(actionFor(0, 6, 2)).toBe(1);
    expect(actionFor(0, 4, 2)).toBeNull();
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

  test("a newer call takes a body row from the block behind it", () => {
    const renderers = resolver()("read", () => undefined) as Renderers;
    const older = { ...ctx, state: undefined as unknown as { expansion: number; hover: boolean } };
    renderers.renderCall(older.args, theme, older);
    const body = renderers.renderResult(result, {}, theme, older);
    expect(body.render(80)).toHaveLength(7);

    const newer = {
      ...ctx,
      args: { path: "another.ts" },
      state: undefined as unknown as { expansion: number; hover: boolean },
    };
    renderers.renderCall(newer.args, theme, newer);
    expect(body.render(80)).toHaveLength(6);
  });
});
