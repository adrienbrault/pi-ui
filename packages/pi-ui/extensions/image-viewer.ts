/**
 * The image viewer: a click on an image in a tool row opens it large, below the transcript, and
 * the left and right arrows step through every image of the session's tool results in transcript
 * order. Escape, Enter or q close it.
 *
 * The viewer draws each image with the constructor of the image pi drew, so it uses pi's copy of
 * pi-tui: its terminal capabilities and cell size, not a second copy's guesses.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** pi-tui's Image, as far as the viewer uses it. */
export interface SourceImage {
  base64Data: string;
  mimeType: string;
  theme?: unknown;
  dimensions?: unknown;
  options?: { maxWidthCells?: number; maxHeightCells?: number };
  render(width: number): string[];
  invalidate?: () => void;
}

export interface ViewerImage {
  source: SourceImage;
  /** What the caption names: the tool and its title, `read · shots/home.png`. */
  label: string;
}

/** Rows the caption and the margin below the image take. */
const VIEWER_CHROME_ROWS = 2;
/** Terminal rows the viewer leaves to pi's chrome around it (status, footer). */
const VIEWER_MARGIN_ROWS = 6;

let ui: ExtensionContext["ui"] | undefined;
let showing = false;

export function installImageViewer(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    ui = ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;
  });
}

export function isViewerImage(value: unknown): value is SourceImage {
  const candidate = value as Partial<SourceImage> | undefined;
  return (
    typeof candidate?.render === "function" &&
    typeof candidate.base64Data === "string" &&
    typeof candidate.mimeType === "string"
  );
}

/** What a key does in the viewer: the image to show next, `close`, or undefined when it does nothing. */
export function viewerStep(data: string, index: number, count: number): number | "close" | undefined {
  if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") return "close";
  if (matchesKey(data, "left")) return Math.max(0, index - 1);
  if (matchesKey(data, "right")) return Math.min(count - 1, index + 1);
  return undefined;
}

/** A new image like `source`, drawn by pi's own Image class. */
function copyOf(source: SourceImage): SourceImage | undefined {
  const Image = source.constructor as unknown as new (...args: unknown[]) => SourceImage;
  try {
    return new Image(source.base64Data, source.mimeType, source.theme, {}, source.dimensions);
  } catch {
    return undefined;
  }
}

/** Open the viewer on `images[start]`. False when it cannot: no UI, already open, nothing to show. */
export function openImageViewer(images: ViewerImage[], start: number): boolean {
  if (!ui || showing || !images[start]) return false;
  showing = true;
  const copies = new Map<number, SourceImage | undefined>();
  const imageAt = (index: number) => {
    if (!copies.has(index)) copies.set(index, copyOf(images[index]!.source));
    return copies.get(index);
  };
  void ui
    .custom<void>((tui, theme, _keybindings, done) => {
      let index = start;
      return {
        render(width: number): string[] {
          const terminalRows = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
          const height = Math.max(4, terminalRows - VIEWER_MARGIN_ROWS - VIEWER_CHROME_ROWS);
          const caption = `${index + 1} of ${images.length} · ${images[index]!.label}`;
          const keys = images.length > 1 ? "← → switch images · esc closes" : "esc closes";
          const head = theme.fg("dim", `${caption} · ${keys}`);
          const image = imageAt(index);
          if (!image) return [head, ""];
          const size = { maxWidthCells: Math.max(1, width - 2), maxHeightCells: height };
          if (image.options?.maxWidthCells !== size.maxWidthCells || image.options?.maxHeightCells !== height) {
            image.options = size;
            image.invalidate?.();
          }
          return [head, ...image.render(width), ""];
        },
        handleInput(data: string): void {
          const step = viewerStep(data, index, images.length);
          if (step === "close") done();
          else if (step !== undefined && step !== index) {
            index = step;
            tui.requestRender();
          }
        },
        invalidate(): void {
          for (const image of copies.values()) image?.invalidate?.();
        },
      };
    })
    .finally(() => {
      showing = false;
    });
  return true;
}
