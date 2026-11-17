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
].join("\n");

export const MCP_OUTPUT = ["memory: 3 facts stored", "keys: onboarding, deploy, incident-2026-11"].join("\n");

export const cwd = "/repo";
export const readPath = "src/core/session.ts";
export const editPath = "extensions/prism/decorator.ts";
