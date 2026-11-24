import { describe, expect, test } from "bun:test";
import { installImageViewer, openImageViewer, viewerStep, type ViewerImage } from "./image-viewer.ts";
import { sizeImages, spansOf } from "./thinking.ts";

/** A stand-in for pi-tui's Image: as many rows as its height option allows, 27 without one. */
class FakeImage {
  constructor(
    public base64Data: string,
    public mimeType: string,
    public theme: unknown = undefined,
    public options: { maxWidthCells?: number; maxHeightCells?: number } = {},
  ) {}
  invalidate(): void {}
  render(_width: number): string[] {
    return Array.from({ length: this.options.maxHeightCells ?? 27 }, (_, row) => (row ? "" : `<${this.base64Data}>`));
  }
}

/** The viewer's component, as the fake UI hands it out. */
interface FakeView {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse(event: unknown): unknown;
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

/**
 * A UI whose `custom` keeps the viewer's factory, so a test can call it: the viewer installs
 * itself on `session_start`, and every open asks the UI for one component.
 */
function fakeUi() {
  const state: { factory?: (...args: any[]) => FakeView; resolve?: () => void } = {};
  installImageViewer({
    on: (_event: string, handler: (event: unknown, ctx: unknown) => void) =>
      handler(
        {},
        {
          hasUI: true,
          mode: "tui",
          ui: {
            custom: (make: (...args: any[]) => FakeView) => {
              state.factory = make;
              return new Promise<void>((resolve) => {
                state.resolve = resolve;
              });
            },
          },
        },
      ),
  } as never);
  return state;
}

/** Open the viewer on `images[start]`, and report whether its `done` ran. */
function openView(state: ReturnType<typeof fakeUi>, images: ViewerImage[], start: number) {
  state.factory = undefined;
  state.resolve = undefined;
  expect(openImageViewer(images, start)).toBe(true);
  let closed = false;
  const done = () => {
    closed = true;
    state.resolve?.();
  };
  const view = state.factory!(
    { terminal: { rows: 40 }, requestRender: () => {} },
    { fg: (_token: string, text: string) => text },
    {},
    done,
  );
  return { view, closed: () => closed };
}

describe("image viewer", () => {
  test("arrows step through the images and stop at either end; escape, enter and q close", () => {
    expect(viewerStep(RIGHT, 0, 3)).toBe(1);
    expect(viewerStep(RIGHT, 2, 3)).toBe(2);
    expect(viewerStep(LEFT, 0, 3)).toBe(0);
    expect(viewerStep(LEFT, 2, 3)).toBe(1);
    for (const key of ["\x1b", "\r", "q"]) expect(viewerStep(key, 1, 3)).toBe("close");
    expect(viewerStep("x", 1, 3)).toBeUndefined();
  });

  test("it opens on the clicked image, large and centred, under a caption; the arrows switch images", async () => {
    const state = fakeUi();
    const images: ViewerImage[] = [
      { source: new FakeImage("one", "image/png"), label: "read · a.png" },
      { source: new FakeImage("two", "image/png"), label: "read · b.png" },
    ];
    const { view } = openView(state, images, 1);
    // A second click while it is open does not open another.
    expect(openImageViewer(images, 0)).toBe(false);
    const rows = view.render(100);
    expect(rows[0]).toBe("2 of 2 · read · b.png · ← → switch images · click or esc closes");
    // At 100 columns a five-cell image starts 47 columns in; the image fills the rows the caption leaves.
    expect(rows[1]).toBe(`${" ".repeat(47)}<two>`);
    expect(rows).toHaveLength(1 + 32);
    view.handleInput(LEFT);
    expect(view.render(100)[1]).toBe(`${" ".repeat(47)}<one>`);
    // Closing frees the viewer for the next click.
    view.handleInput("\x1b");
    await Bun.sleep(0);
  });

  test("escape closes the viewer, and a click anywhere in it does too", async () => {
    const state = fakeUi();
    const images: ViewerImage[] = [{ source: new FakeImage("one", "image/png"), label: "read · a.png" }];
    const byEscape = openView(state, images, 0);
    expect(byEscape.view.render(100)[0]).toBe("1 of 1 · read · a.png · click or esc closes");
    byEscape.view.handleInput("\x1b");
    expect(byEscape.closed()).toBe(true);
    await Bun.sleep(0);
    const byClick = openView(state, images, 0);
    // On the image, beside it or on the caption: while the frame is open it owns every row.
    expect(byClick.view.handleMouse({ type: "move", button: "left", x: 50, y: 8 })).toBeUndefined();
    expect(byClick.closed()).toBe(false);
    expect(byClick.view.handleMouse({ type: "click", button: "left", x: 50, y: 8 })).toEqual({
      handled: true,
      render: false,
    });
    expect(byClick.closed()).toBe(true);
    await Bun.sleep(0);
  });

  test("a row's image spans sit after their spacers at the end of its rows", () => {
    const first = new FakeImage("a", "image/png");
    const second = new FakeImage("b", "image/png");
    const spacers = [{ render: () => [""] }, { render: () => [""] }];
    const component = { imageComponents: [first, second], imageSpacers: spacers };
    sizeImages(component, () => ({ level: 7, open: false, folded: false }));
    // pi draws: a blank, two content rows, then each spacer and its image.
    const rows = [
      "",
      "head",
      "body",
      ...spacers[0]!.render(),
      ...first.render(100),
      ...spacers[1]!.render(),
      ...second.render(100),
    ];
    expect(spansOf(component, rows.length)).toEqual([
      { start: 4, end: 7, image: first },
      { start: 8, end: 11, image: second },
    ]);
  });
});

describe("image viewer registration", () => {
  test("the extension's entry point gives the viewer the session's UI", async () => {
    const { default: piUi } = await import("./index.ts");
    const starts: Array<(event: unknown, ctx: unknown) => void> = [];
    piUi({
      registerToolRenderer: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
        if (event === "session_start") starts.push(handler);
      },
    } as never);
    let opened = 0;
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: () => {},
        custom: () => {
          opened += 1;
          return new Promise<void>(() => {});
        },
      },
    };
    for (const start of starts) start({}, ctx);
    expect(openImageViewer([{ source: new FakeImage("x", "image/png"), label: "read" }], 0)).toBe(true);
    expect(opened).toBe(1);
  });
});
