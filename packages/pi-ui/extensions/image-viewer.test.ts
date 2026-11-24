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

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

describe("image viewer", () => {
  test("arrows step through the images and stop at either end; escape, enter and q close", () => {
    expect(viewerStep(RIGHT, 0, 3)).toBe(1);
    expect(viewerStep(RIGHT, 2, 3)).toBe(2);
    expect(viewerStep(LEFT, 0, 3)).toBe(0);
    expect(viewerStep(LEFT, 2, 3)).toBe(1);
    for (const key of ["\x1b", "\r", "q"]) expect(viewerStep(key, 1, 3)).toBe("close");
    expect(viewerStep("x", 1, 3)).toBeUndefined();
  });

  test("it opens on the clicked image, large, under a caption, and the arrows switch images", async () => {
    let factory: ((...args: any[]) => any) | undefined;
    let closed = false;
    installImageViewer({
      on: (_event: string, handler: (event: unknown, ctx: unknown) => void) =>
        handler(
          {},
          {
            hasUI: true,
            mode: "tui",
            ui: {
              custom: (make: (...args: any[]) => any) => {
                factory = make;
                return new Promise<void>((resolve) => {
                  (globalThis as { closeViewer?: () => void }).closeViewer = resolve;
                });
              },
            },
          },
        ),
    } as never);
    const images: ViewerImage[] = [
      { source: new FakeImage("one", "image/png"), label: "read · a.png" },
      { source: new FakeImage("two", "image/png"), label: "read · b.png" },
    ];
    expect(openImageViewer(images, 1)).toBe(true);
    // A second click while it is open does not open another.
    expect(openImageViewer(images, 0)).toBe(false);
    const view = factory!(
      { terminal: { rows: 40 }, requestRender: () => {} },
      { fg: (_token: string, text: string) => text },
      {},
      () => {
        closed = true;
        (globalThis as { closeViewer?: () => void }).closeViewer?.();
      },
    );
    const rows = view.render(100) as string[];
    expect(rows[0]).toBe("2 of 2 · read · b.png · ← → switch images · esc closes");
    expect(rows[1]).toBe("<two>");
    // The terminal's rows less pi's chrome and the caption: far taller than a tool row's image.
    expect(rows).toHaveLength(1 + 32 + 1);
    view.handleInput(LEFT);
    expect((view.render(100) as string[])[1]).toBe("<one>");
    view.handleInput("\x1b");
    expect(closed).toBe(true);
    await Bun.sleep(0);
    expect(openImageViewer(images, 0)).toBe(true);
    (globalThis as { closeViewer?: () => void }).closeViewer?.();
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
