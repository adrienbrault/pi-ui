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
  "click pins a block open until clicked again",
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

/** A log longer than any preview: its tail is kept and the rest counted above it. */
/** `rg -n -A1` across two files: context lines, a `--` between groups, and a change of file. */
export const SHELL_GREP = [
  "extensions/index.ts:326:      const layout = toolRowLayout({ ...api, owner: record }, input, width);",
  "extensions/index.ts-327-      let rows = layout.rows.slice(includeHeader ? 0 : 1);",
  "--",
  "extensions/index.ts:387:      return renderToolRow({ ...api, owner: member }, input).render(innerWidth);",
  "extensions/index.ts-388-    }) as Component,",
  "--",
  'render/index.ts:10:export { renderToolRow, toolRowLayout } from "./tool-row.ts";',
].join("\n");

export const SHELL_LONG = [
  "c477023 test(pi-prism): a collapsing group rebuilt mid-row hands its collapse on",
  "9bce9ff fix(pi-prism): a narrow open group drops its table on every row at once",
  "1ddc373 fix(pi-prism): a restarted session keeps its probe until it has the TUI",
  "8b3bdec refactor(pi-prism): drop the unused indented and padBetween kit helpers",
  "c9ee8be test(dev): wait for an opened thought's own body row",
  "* main c477023 test(pi-prism): a collapsing group rebuilt mid-row hands its collapse on",
  "AGENTS.md",
  "biome.json",
  "bun.lock",
  "CLAUDE.md",
  "DESIGN.md",
  "design-system",
  "dev",
  "docs",
  "node_modules",
  "package.json",
  "packages",
  "README.md",
  "review-eval",
  "tsconfig.json",
].join("\n");

export const EDIT_DIFF = [
  "diff --git a/extensions/prism/decorator.ts b/extensions/prism/decorator.ts",
  "index 3f9c1aa..8b2d410 100644",
  "@@ -1,8 +1,13 @@",
  ' import type { ComponentLike } from "../../tui/dist/index.js";',
  ' import { renderToolRow } from "../../packages/pi-prism/render/tool-row.ts";',
  "-export function decorate(component: ComponentLike): ComponentLike {",
  "-  return component;",
  "+",
  "+interface DecoratorOptions {",
  "+  width: number;",
  "+  level: DetailLevel;",
  "+}",
  "+",
  "+export function decorate(component: ComponentLike, options: DecoratorOptions): ComponentLike {",
  "+  return compose(component, options.width, options.level);",
  " }",
  "@@ -24,16 +29,28 @@ function compose(component, width, level) {",
  "   const rows = component.render(width);",
  "-  return { render: () => rows, invalidate() {} };",
  "+  return {",
  "+    render: (next: number) => rows.map((row) => fit(row, next)),",
  "+    invalidate() {",
  "+      cache.clear();",
  "+    },",
  "+  };",
  " }",
  "+",
  "+const cache = new Map<string, string[]>();",
  "+",
  "+function fit(row: string, width: number): string {",
  "+  const key = `${width}:${row}`;",
  "+  const known = cache.get(key);",
  '+  if (known) return known[0] ?? "";',
  '+  const fitted = truncateToWidth(row, width, "…");',
  "+  cache.set(key, [fitted]);",
  "+  return fitted;",
  "+}",
  "@@ -52,7 +69,11 @@ export function planTranscript(blocks: BlockShape[]) {",
  "   const items: TranscriptItem[] = [];",
  "-  let folded: BlockShape[] = [];",
  "+  let folded: BlockShape[] = [];",
  "+  let foldedIndices: number[] = [];",
  " ",
  "   const flush = () => {",
  "+    if (folded.length === 0) return;",
  '     items.push({ kind: "group", segments: groupSegments(folded) });',
  "+    foldedIndices = [];",
  "   };",
].join("\n");

export const MCP_OUTPUT = ["memory: 3 facts stored", "keys: onboarding, deploy, incident-2026-11"].join("\n");
export const cwd = "/repo";
export const readPath = "src/core/session.ts";
export const editPath = "extensions/prism/decorator.ts";
