/**
 * Fixture data. Deterministic inputs, so every card and fixture is reproducible.
 */

export const THINKING_TEXT = [
  "I need to find where the transcript rows are composed.",
  "start with package.json then core/session.ts",
  "the interactive mode imports AssistantMessageComponent",
  "reasoning: hidden thinking labels default to 'Thinking...'",
  "tool rows own a leading Spacer, so grouping must neutralise it",
  "recency should be measured from the tail of the current run",
  "decay only on structural events, never per token",
  "hysteresis prevents flicker while streaming",
  "click pins a block open until the next turn",
].join("\n");

export const FILE_TEXT = [
  "{",
  '  "name": "pi-prism",',
  '  "version": "0.0.0",',
  '  "type": "module",',
  '  "pi": { "extensions": ["./extensions/index.ts"] },',
  '  "peerDependencies": {',
  '    "@earendil-works/pi-coding-agent": "*",',
  '    "@earendil-works/pi-tui": "*"',
  "  }",
  "}",
].join("\n");

export const SHELL_OUTPUT = [
  "> pi-prism@0.0.0 typecheck",
  "> tsc --noEmit",
  "",
  "design-system/build.ts:41:18 - error TS2339:",
  "  Property 'registerTranscript' does not exist on type 'ExtensionAPI'.",
  "",
  "Found 1 error in 1 file.",
  "exit code 2",
].join("\n");

export const SHELL_OK = [
  "$ bun run ds",
  "resolved pi 1.5.x from nvm",
  "rendered 212 surfaces across 3 widths",
  "wrote design-system/web/index.html",
].join("\n");

export const EDIT_DIFF = [
  "@@ -41,7 +41,9 @@",
  " export interface RenderKit {",
  "-  truncate(line: string, width: number): string;",
  "+  /** ANSI-aware truncation. */",
  "+  truncateToWidth(line: string, width: number, ellipsis?: string): string;",
  "   visibleWidth(text: string): number;",
  " }",
  "@@ -58,10 +60,14 @@ export interface RenderApi {",
  "   kit: RenderKit;",
  "   theme: RenderTheme;",
  "-  glyphs: GlyphSet;",
  "+  glyphs: GlyphSet;",
  "+  width: number;",
  " }",
  "+",
  "+export function render(lines: string[], api: RenderApi) {",
  "+  return lines.map((line) => api.kit.truncateToWidth(line, api.width));",
  "+}",
].join("\n");

export const MCP_OUTPUT = ["memory: 3 facts stored", "keys: onboarding, deploy, incident-2026-11"].join("\n");
export const cwd = "/repo";
export const readPath = "src/core/session.ts";
export const editPath = "extensions/prism/decorator.ts";

// --- Session replay fixtures ------------------------------------------------

export const SESSION_THINKING = [
  "The transcript appends one row per event and never looks back.",
  "session.ts owns the message list; the TUI just re-renders it from the tail.",
  "So age has to be derived from the tail, not stored on the row itself.",
  "Distance from the tail is the only stable signal while tokens are still arriving.",
  "Two recomputes must agree before a level changes, or the page flickers mid-stream.",
  "A click pins a block open until the next turn replaces the pin.",
  "Pi also puts a leading Spacer above every tool row.",
  "Grouping has to neutralise that spacer without ever moving the header.",
].join("\n");

export const SESSION_THINKING_2 = [
  "The failure is in the body budget, not the diff renderer.",
  "bodyLinesFor(3) still returns a body row instead of zero.",
  "Fix the ladder first; the grouping test follows from it.",
  "Watch the floor: a one-line block must keep that line for another turn.",
  "After the ladder, re-check the fold distance against a long session.",
].join("\n");

export const SESSION_CODE = [
  "/** Session owns the transcript and asks the TUI to repaint. */",
  'import type { Message } from "./message.ts";',
  'import type { Tui } from "../tui.ts";',
  "",
  "export class Session {",
  "  private messages: Message[] = [];",
  "  private listeners = new Set<() => void>();",
  "",
  "  constructor(private readonly tui: Tui) {}",
  "",
  "  append(message: Message) {",
  "    this.messages.push(message);",
  "    this.tui.requestRender();",
  "  }",
  "",
  "  replace(index: number, message: Message) {",
  "    this.messages[index] = message;",
  "    this.tui.requestRender();",
  "  }",
  "",
  "  last(count: number): Message[] {",
  "    return this.messages.slice(-count);",
  "  }",
  "",
  "  onChange(listener: () => void) {",
  "    this.listeners.add(listener);",
  "    return () => this.listeners.delete(listener);",
  "  }",
  "}",
].join("\n");

export const ASSISTANT_SOURCE = [
  "export class AssistantMessageComponent extends Container {",
  "  private hideThinking = false;",
  '  private hiddenLabel = "Thinking...";',
  "  private thinkingRows = 0;",
  "",
  "  setHideThinkingBlock(hide: boolean) {",
  "    this.hideThinking = hide;",
  "    this.invalidate();",
  "  }",
  "",
  "  setHiddenThinkingLabel(label: string) {",
  "    this.hiddenLabel = label;",
  "    this.invalidate();",
  "  }",
  "",
  "  render(width: number): string[] {",
  "    if (this.hideThinking) return [this.hiddenLabel];",
  "    return this.body.render(width);",
  "  }",
  "}",
].join("\n");

export const GREP_OUTPUT = [
  "src/core/session.ts:41: pi.registerToolRenderer(...)",
  "src/core/registry.ts:12: registerToolRenderer(definition)",
  "src/modes/interactive/interactive-mode.ts:88: ...",
  "src/modes/interactive/components/assistant-message.ts:12: ...",
  "src/extensions/loader.ts:203: registerToolRenderer",
  "5 matches in 5 files",
].join("\n");

export const TEST_FAIL = [
  "$ bun test",
  "✗ decay ladder > folded rows keep one line",
  "✓ tool rows > level 3 is a single line",
  "1 pass, 1 fail",
  "exit code 1",
].join("\n");

export const TEST_OK = ["$ bun test", "28 pass, 0 fail", "70 expect() calls across 1 file"].join("\n");

export const DETAIL_DIFF = [
  "@@ -12,9 +12,13 @@",
  "-  const BODY_LINES: Record<DetailLevel, number> = { 0: 7, 1: 6, 2: 5, 3: 4 };",
  "+  const BODY_LINES: Record<DetailLevel, number> = {",
  "+    0: 7,",
  "+    1: 6,",
  "+    2: 5,",
  "+    3: 4,",
  "+    4: 3,",
  "+    5: 2,",
  "+    6: 1,",
  "+  };",
  "   export function bodyLinesFor(level: DetailLevel): number {",
  "     return BODY_LINES[level];",
  "   }",
  "@@ -40,5 +44,7 @@",
  "-export const FOLD_LEVEL: DetailLevel = 4;",
  "+/** One line is never worth dropping: fold only when the run needs room. */",
  "+export const FOLD_DISTANCE = 8;",
  " ",
  " export function detailFor(distance: number): DetailLevel {",
].join("\n");

export const FINAL_TEXT = [
  "Decay is in. Bodies shed **one row per turn** — 7 → 6 → 5 … → 1 — and a",
  "one-line block keeps its line until the run needs the room. Folded runs",
  "collapse into a single group row, and a failed row never disappears.",
].join("\n");

/** Short assistant notes between runs: prose anchors that split group folds. */
export const SESSION_NOTE_1 =
  "One registration point: `registerToolRenderer` is all I need. The decorator can wrap the component there.";
export const SESSION_NOTE_2 = "Decorator is in place. Running the suite before touching the planner.";
export const SESSION_NOTE_3 = "Green. Now the tail budget itself: does a single line survive long enough?";
