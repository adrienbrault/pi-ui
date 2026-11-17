/**
 * Component registry: every card is a render function over real components.
 * The gallery, spec.json and fixtures all derive from this file.
 */

import type { GlyphSet, GlyphMode } from "../packages/pi-prism/render/glyphs.ts";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";
import { groupSegments, renderGroupRow } from "../packages/pi-prism/render/group-row.ts";
import type { RenderKit } from "../packages/pi-prism/render/kit.ts";
import type { DetailLevel } from "../packages/pi-prism/render/detail.ts";
import { FOLD_DISTANCE, detailFor } from "../packages/pi-prism/render/detail.ts";
import { thinkingLabel } from "../packages/pi-prism/render/thinking.ts";
import { planTranscript, type BlockShape } from "../packages/pi-prism/render/layout.ts";
import {
  FRAME_LABELS,
  PLAYBACK,
  SESSION_STEPS,
  partialLines,
  partialText,
  streamingArgKey,
  type PlaybackFrame,
  type SessionStep,
} from "./session.ts";
import { renderToolLine, renderToolRow, type ToolRowInput } from "../packages/pi-prism/render/tool-row.ts";
import { toolMeta } from "../packages/pi-prism/render/tools.ts";
import type { PiInstall } from "./lib/pi.ts";
import { stack } from "./lib/surface.ts";
import {
  EDIT_DIFF,
  FILE_TEXT,
  MCP_OUTPUT,
  SHELL_OK,
  SHELL_OUTPUT,
  THINKING_TEXT,
  cwd,
  editPath,
  readPath,
} from "./fixtures-data.ts";

export type Variant = "base" | "open-tui" | "pi-code" | "ours";
export type Group = "session" | "transcript" | "tools" | "thinking" | "groups" | "glyphs" | "scenarios";

export interface RenderCtx {
  pi: PiInstall;
  kit: RenderKit;
  theme: any;
  glyphs: GlyphSet;
  glyphMode: GlyphMode;
  width: number;
  themeName: string;
}

export interface StateDef {
  id: string;
  label: string;
  note?: string;
  /** Render this many animation frames instead of one still. */
  frames?: number;
  render: (ctx: RenderCtx, frame: number) => string[];
  /** Folded groups, split into header + member blocks a click can toggle. */
  reveal?: (ctx: RenderCtx, frame: number) => RevealGroup[];
  /** Blocks outside groups whose full body a click can restore. */
  toggles?: (ctx: RenderCtx, frame: number) => ToggleSpec[];
}

/** A collapsed block plus the bodies successive clicks swap in. */
export interface ToggleSpec {
  row: number;
  count: number;
  /** Opening steps: the capped body, then the whole body. */
  opens: string[][];
  key: string;
}

/** A revealed group: its header row plus member blocks in two states. */
export interface RevealMember {
  /** Header row only. */
  collapsed: string[];
  /** Header plus a taste of the body, ending in a "show all" cue. */
  preview: string[];
  /** The whole body, the same view the live tail gets. */
  expanded: string[];
}

export interface RevealGroup {
  header: string[];
  members: RevealMember[];
}

export interface EntryDef {
  id: string;
  title: string;
  group: Group;
  variant: Variant;
  description: string;
  states: StateDef[];
  /** Cards sharing a sync key share one playhead (session lanes). */
  sync?: string;
  /** Cards sharing a stage key render side by side under one control bar. */
  stage?: string;
  /** Per-frame captions, shown by the stage control bar. */
  frameLabels?: string[];
  /** Per-frame duration in ms at 100 tok/s, so playback keeps real pacing. */
  frameCosts?: number[];
  /** Render at this width regardless of the gallery width control. */
  fixedWidth?: number;
  /** Skip in fixtures/frames.json: scenarios, not golden rows. */
  fixture?: false;
}

/** A duck-typed TUI stub: tool rows only need requestRender. */
const STUB_TUI = { requestRender: () => {} };

function definitionFor(pi: PiInstall, name: string): any {
  const factory = {
    read: "createReadToolDefinition",
    bash: "createBashToolDefinition",
    edit: "createEditToolDefinition",
    write: "createWriteToolDefinition",
    grep: "createGrepToolDefinition",
    find: "createFindToolDefinition",
    ls: "createLsToolDefinition",
  }[name];
  return factory ? pi.modules.coding[factory]?.(cwd) : undefined;
}

function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(content: unknown[]) {
  return {
    role: "assistant",
    api: "anthropic",
    provider: "anthropic",
    model: "claude-sonnet-5",
    content,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

interface BaseToolOptions {
  expanded?: boolean;
  partial?: boolean;
}

function baseTool(
  pi: PiInstall,
  name: string,
  args: Record<string, unknown>,
  result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean },
  options: BaseToolOptions = {},
): any {
  const component = new pi.modules.coding.ToolExecutionComponent(
    name,
    "call-1",
    args,
    { outputPad: 1, showImages: true },
    definitionFor(pi, name),
    STUB_TUI,
    cwd,
  );
  component.updateArgs(args);
  component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult(result, options.partial ?? false);
  if (options.expanded) component.setExpanded(true);
  return component;
}

/**
 * A tool call captured mid-flight: arguments may still be arriving and the
 * output may be partial, exactly the states pi renders while streaming.
 */
function baseToolStreaming(
  pi: PiInstall,
  name: string,
  args: Record<string, unknown>,
  output: string,
  options: { argsComplete: boolean; partial: boolean; isError: boolean },
): any {
  const component = new pi.modules.coding.ToolExecutionComponent(
    name,
    "call-1",
    args,
    { outputPad: 1, showImages: true },
    definitionFor(pi, name),
    STUB_TUI,
    cwd,
  );
  component.updateArgs(args);
  if (options.argsComplete) component.setArgsComplete();
  component.markExecutionStarted();
  component.updateResult(
    { content: [{ type: "text", text: output }], details: {}, isError: options.isError },
    options.partial,
  );
  return component;
}

function baseAssistant(pi: PiInstall, content: unknown[], hideThinking: boolean, label = "Thinking..."): any {
  return new pi.modules.coding.AssistantMessageComponent(
    assistantMessage(content),
    hideThinking,
    pi.modules.coding.getMarkdownTheme(),
    label,
    1,
  );
}

/** Mimic pi's hidden-thinking Text so a scenario stack can show the label. */
/** The label paints its own rows: header at full contrast, body muted italic. */
function thinkingBlock(ctx: RenderCtx, label: string) {
  return ctx.kit.component((width) => label.split("\n").map((line) => ctx.kit.truncateToWidth(line, width, "…")));
}

const readRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "read",
  args: { path: readPath },
  status: "success",
  level: 0,
  title: readPath,
  summary: "42 lines",
  output: FILE_TEXT,
  durationMs: 380,
  ...overrides,
});

const bashRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "bash",
  args: { command: "bun run typecheck" },
  status: "success",
  level: 0,
  title: "bun run typecheck",
  output: SHELL_OK,
  durationMs: 1240,
  ...overrides,
});

const editRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "edit",
  args: { path: editPath },
  status: "success",
  level: 0,
  title: editPath,
  summary: "+8 −2",
  output: EDIT_DIFF,
  durationMs: 210,
  ...overrides,
});

const mcpRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "mcp__memory__search",
  args: { query: "recency grading" },
  status: "success",
  level: 0,
  title: "memory/search",
  summary: "3 facts",
  output: MCP_OUTPUT,
  durationMs: 95,
  ...overrides,
});

const ours = (ctx: RenderCtx) => ({
  kit: ctx.kit,
  theme: ctx.theme,
  glyphs: ctx.glyphs,
});

// ---------------------------------------------------------------------------
// Base pi
// ---------------------------------------------------------------------------

const baseEntries: EntryDef[] = [
  {
    id: "base.user",
    title: "User message",
    group: "transcript",
    variant: "base",
    description: "The bubble pi draws for a submitted prompt.",
    states: [
      {
        id: "default",
        label: "default",
        render: (ctx) =>
          new ctx.pi.modules.coding.UserMessageComponent(
            "Let's make long sessions readable: keep the live detail, fold the rest.",
            ctx.pi.modules.coding.getMarkdownTheme(),
            1,
          ).render(ctx.width),
      },
    ],
  },
  {
    id: "base.assistant.thinking",
    title: "Assistant + thinking (visible)",
    group: "transcript",
    variant: "base",
    description: "Thinking blocks render as Markdown when pi's hide toggle is off.",
    states: [
      {
        id: "visible",
        label: "thinking visible",
        render: (ctx) => {
          const content = [
            { type: "thinking", thinking: THINKING_TEXT },
            { type: "text", text: "Reading the layout root, then wrapping each child render." },
          ];
          return baseAssistant(ctx.pi, content, false).render(ctx.width);
        },
      },
    ],
  },
  {
    id: "base.assistant.hidden",
    title: "Assistant + thinking (hidden)",
    group: "transcript",
    variant: "base",
    description: "The shipped collapsed form: one global label, no per-turn detail.",
    states: [
      {
        id: "hidden",
        label: "thinking hidden",
        render: (ctx) => {
          const content = [
            { type: "thinking", thinking: THINKING_TEXT },
            { type: "text", text: "Reading the layout root, then wrapping each child render." },
          ];
          return baseAssistant(ctx.pi, content, true).render(ctx.width);
        },
      },
    ],
  },
  {
    id: "base.tool.read",
    title: "read (base pi)",
    group: "tools",
    variant: "base",
    description: "Built-in read renderer: path, line range, preview.",
    states: [
      {
        id: "success",
        label: "success",
        render: (ctx) =>
          baseTool(
            ctx.pi,
            "read",
            { path: readPath },
            {
              content: [{ type: "text", text: FILE_TEXT }],
              details: {},
              isError: false,
            },
          ).render(ctx.width),
      },
      {
        id: "expanded",
        label: "expanded",
        render: (ctx) =>
          baseTool(
            ctx.pi,
            "read",
            { path: readPath },
            { content: [{ type: "text", text: FILE_TEXT }], details: {}, isError: false },
            { expanded: true },
          ).render(ctx.width),
      },
    ],
  },
  {
    id: "base.tool.bash",
    title: "bash (base pi)",
    group: "tools",
    variant: "base",
    description: "Shell output with pi's preview cap and expand hint.",
    states: [
      {
        id: "success",
        label: "success",
        render: (ctx) =>
          baseTool(
            ctx.pi,
            "bash",
            { command: "bun run typecheck" },
            {
              content: [{ type: "text", text: SHELL_OK }],
              details: {},
              isError: false,
            },
          ).render(ctx.width),
      },
      {
        id: "error",
        label: "error",
        render: (ctx) =>
          baseTool(
            ctx.pi,
            "bash",
            { command: "bun run typecheck" },
            {
              content: [{ type: "text", text: SHELL_OUTPUT }],
              details: {},
              isError: true,
            },
          ).render(ctx.width),
      },
    ],
  },
  {
    id: "base.tool.edit",
    title: "edit (base pi)",
    group: "tools",
    variant: "base",
    description: "Diff stats, then the diff itself when expanded.",
    states: [
      {
        id: "success",
        label: "collapsed",
        render: (ctx) =>
          baseTool(
            ctx.pi,
            "edit",
            { path: editPath },
            {
              content: [{ type: "text", text: "Updated the render kit." }],
              details: { diff: EDIT_DIFF, patch: "" },
              isError: false,
            },
          ).render(ctx.width),
      },
      {
        id: "expanded",
        label: "expanded",
        render: (ctx) =>
          baseTool(
            ctx.pi,
            "edit",
            { path: editPath },
            {
              content: [{ type: "text", text: "Updated the render kit." }],
              details: { diff: EDIT_DIFF, patch: "" },
              isError: false,
            },
            { expanded: true },
          ).render(ctx.width),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Ours
// ---------------------------------------------------------------------------

const levelState = (
  id: string,
  label: string,
  level: DetailLevel,
  build: (ctx: RenderCtx) => ToolRowInput,
  note?: string,
): StateDef => ({
  id,
  label,
  note,
  render: (ctx) => renderToolRow(ours(ctx), { ...build(ctx), level }).render(ctx.width),
});

const oursEntries: EntryDef[] = [
  {
    id: "ours.thinking",
    title: "Thinking label",
    group: "thinking",
    variant: "ours",
    description:
      "What can actually ship: a multi-line label on pi's hidden thinking block. Marker + tail, folding with distance.",
    states: [
      {
        id: "streaming",
        label: "streaming L0",
        note: "spinner + up to 6 tail lines",
        frames: 10,
        render: (ctx, frame) => {
          const label = thinkingLabel(ours(ctx), {
            phase: "thinking",
            level: 0,
            text: THINKING_TEXT,
            width: ctx.width,
            frame,
          });
          return baseAssistant(ctx.pi, [{ type: "thinking", thinking: THINKING_TEXT }], true, label).render(ctx.width);
        },
      },
      {
        id: "done",
        label: "done L1",
        render: (ctx) => {
          const label = thinkingLabel(ours(ctx), {
            phase: "done",
            level: 1,
            text: THINKING_TEXT,
            width: ctx.width,
            durationMs: 12400,
          });
          return baseAssistant(ctx.pi, [{ type: "thinking", thinking: THINKING_TEXT }], true, label).render(ctx.width);
        },
      },
      {
        id: "aged1",
        label: "aged L1",
        render: (ctx) =>
          baseAssistant(
            ctx.pi,
            [{ type: "thinking", thinking: THINKING_TEXT }],
            true,
            thinkingLabel(ours(ctx), {
              phase: "aged",
              level: 1,
              text: THINKING_TEXT,
              width: ctx.width,
              durationMs: 12400,
            }),
          ).render(ctx.width),
      },
      {
        id: "aged2",
        label: "aged L2",
        render: (ctx) =>
          baseAssistant(
            ctx.pi,
            [{ type: "thinking", thinking: THINKING_TEXT }],
            true,
            thinkingLabel(ours(ctx), {
              phase: "aged",
              level: 2,
              text: THINKING_TEXT,
              width: ctx.width,
              durationMs: 12400,
            }),
          ).render(ctx.width),
      },
      {
        id: "aged3",
        label: "aged L3",
        note: "one line, keeps the last thought",
        render: (ctx) =>
          baseAssistant(
            ctx.pi,
            [{ type: "thinking", thinking: THINKING_TEXT }],
            true,
            thinkingLabel(ours(ctx), {
              phase: "aged",
              level: 3,
              text: THINKING_TEXT,
              width: ctx.width,
              durationMs: 12400,
            }),
          ).render(ctx.width),
      },
    ],
  },
  {
    id: "ours.read",
    title: "read row",
    group: "tools",
    variant: "ours",
    description: "Header + bounded body. Level decides how many rows survive; errors stay legible.",
    states: [
      levelState("pending", "pending", 0, () => readRow({ status: "pending", output: "" })),
      {
        id: "running",
        label: "running L0",
        frames: 10,
        render: (ctx, frame) =>
          renderToolRow(ours(ctx), readRow({ status: "running", output: FILE_TEXT, level: 0, frame })).render(
            ctx.width,
          ),
      },
      levelState("l0", "success L0", 0, () => readRow()),
      levelState("l1", "aged L1", 1, () => readRow()),
      levelState("l2", "aged L2", 2, () => readRow()),
      levelState("l3", "aged L3", 3, () => readRow()),
      levelState("error", "error", 0, () =>
        readRow({ status: "error", error: "ENOENT: no such file", output: "", summary: "" }),
      ),
    ],
  },
  {
    id: "ours.bash",
    title: "bash row",
    group: "tools",
    variant: "ours",
    description: "Shell rows trend on the tail: the latest frames are what matter.",
    states: [
      {
        id: "running",
        label: "running L0",
        note: "latest output while streaming",
        frames: 10,
        render: (ctx, frame) =>
          renderToolRow(
            ours(ctx),
            bashRow({
              status: "running",
              title: "bun run typecheck",
              output: SHELL_OUTPUT,
              level: 0,
              durationMs: undefined,
              frame,
            }),
          ).render(ctx.width),
      },
      levelState("l0", "success L0", 0, () => bashRow()),
      levelState("l1", "aged L1", 1, () => bashRow()),
      levelState("l3", "aged L3", 3, () => bashRow()),
      levelState("error", "failed", 0, () =>
        bashRow({ status: "error", output: SHELL_OUTPUT, summary: "", error: "exit 2" }),
      ),
    ],
  },
  {
    id: "ours.edit",
    title: "edit row",
    group: "tools",
    variant: "ours",
    description: "Diff stat in the header; diff rows trend on the head.",
    states: [
      levelState("l0", "success L0", 0, () => editRow()),
      levelState("l1", "aged L1", 1, () => editRow()),
      levelState("l3", "aged L3", 3, () => editRow()),
      levelState("error", "error", 0, () =>
        editRow({ status: "error", error: "old_string not found", output: "", summary: "" }),
      ),
    ],
  },
  {
    id: "ours.mcp",
    title: "MCP row",
    group: "tools",
    variant: "ours",
    description: "mcp__server__tool becomes server/tool, with a generic or tool-specific summary.",
    states: [levelState("l0", "success L0", 0, () => mcpRow()), levelState("l3", "aged L3", 3, () => mcpRow())],
  },
  {
    id: "ours.group",
    title: "Group summary",
    group: "groups",
    variant: "ours",
    description: "Contiguous collapsed rows of one class become one line. Failures keep their own count.",
    states: [
      {
        id: "collapsed",
        label: "collapsed",
        render: (ctx) =>
          renderGroupRow(ours(ctx), {
            segments: groupSegments([
              { cls: "read" },
              { cls: "read" },
              { cls: "read" },
              { cls: "read" },
              { cls: "shell" },
              { cls: "shell" },
              { cls: "edit" },
            ]),
          }).render(ctx.width),
      },
      {
        id: "expanded",
        label: "expanded",
        render: (ctx) =>
          renderGroupRow(ours(ctx), {
            segments: groupSegments([
              { cls: "read" },
              { cls: "read" },
              { cls: "read" },
              { cls: "read" },
              { cls: "shell" },
              { cls: "shell" },
            ]),
            expanded: true,
          }).render(ctx.width),
      },
      {
        id: "failed",
        label: "with failure",
        render: (ctx) =>
          renderGroupRow(ours(ctx), {
            segments: groupSegments([
              { cls: "shell" },
              { cls: "shell", failed: true },
              { cls: "read" },
              { cls: "read" },
            ]),
          }).render(ctx.width),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface ScenarioRow extends ToolRowInput {
  key: string;
}

const decayRows: ScenarioRow[] = [
  { ...readRow({ title: "src/core/session.ts", summary: "312 lines" }), key: "read-1" },
  { ...readRow({ title: "src/modes/interactive/interactive-mode.js", summary: "6107 lines" }), key: "read-2" },
  { ...bashRow({ title: "rg -n 'registerToolRenderer' src", output: SHELL_OK }), key: "bash-1" },
  { ...editRow({ title: "extensions/prism/decorator.ts", summary: "+42 −7" }), key: "edit-1" },
  {
    ...readRow({ title: "src/modes/interactive/components/assistant-message.js", summary: "181 lines" }),
    key: "read-3",
  },
  { ...editRow({ title: "extensions/prism/thinking.ts", summary: "+18 −3" }), key: "edit-2" },
  { ...bashRow({ title: "bun test", output: SHELL_OK, durationMs: 8100 }), key: "bash-2" },
  { ...mcpRow({ title: "memory/search" }), key: "mcp-1" },
];

function decayStack(ctx: RenderCtx, offset: number): string[] {
  const components: Array<{ render(width: number): string[] }> = [];
  const rows = decayRows.map((row, index) => ({
    row,
    distance: offset + (decayRows.length - 1 - index),
  }));

  const folded = rows.filter(({ distance }) => distance >= FOLD_DISTANCE);
  const segments = groupSegments(
    folded.map(({ row }) => ({ cls: toolMeta(row.name).cls, failed: row.status === "error" })),
  );

  let groupRendered = false;
  for (const { row, distance } of rows) {
    const level = detailFor(distance);
    if (distance >= FOLD_DISTANCE) {
      if (!groupRendered) {
        components.push(renderGroupRow(ours(ctx), { segments }));
        groupRendered = true;
      }
      continue;
    }
    components.push(renderToolRow(ours(ctx), { ...row, level }));
  }

  components.push(
    thinkingBlock(
      ctx,
      thinkingLabel(ours(ctx), {
        phase: "thinking",
        level: 0,
        text: THINKING_TEXT,
        width: ctx.width,
        frame: 0,
      }),
    ),
  );

  return stack(ctx.width, components, 1);
}

/**
 * What a click on the decay group opens: the same folded rows, but split into a
 * toggleable header and per-member blocks. Collapsed = header only.
 */
function decayReveal(ctx: RenderCtx, offset: number): RevealGroup[] {
  const rows = decayRows.map((row, index) => ({
    row,
    distance: offset + (decayRows.length - 1 - index),
  }));
  const folded = rows.filter(({ distance }) => distance >= FOLD_DISTANCE);
  if (folded.length === 0) return [];
  const segments = groupSegments(
    folded.map(({ row }) => ({ cls: toolMeta(row.name).cls, failed: row.status === "error" })),
  );
  return [
    {
      header: renderGroupRow(ours(ctx), { segments, expanded: true }).render(ctx.width),
      members: folded.map(({ row }) => {
        const collapsed = renderToolLine(ours(ctx), row).render(ctx.width);
        const preview = renderToolRow(ours(ctx), { ...row, level: 4 }).render(ctx.width);
        const expanded = renderToolRow(ours(ctx), { ...row, expanded: true }).render(ctx.width);
        return {
          collapsed,
          // A member with nothing hidden offers no opening at all.
          preview:
            expanded.length > preview.length
              ? [...preview, ours(ctx).theme.fg("dim", `▸ show all ${expanded.length} lines`)]
              : collapsed,
          expanded,
        };
      }),
    },
  ];
}

const scenarioEntries: EntryDef[] = [
  {
    id: "scenario.decay",
    title: "Decay ladder",
    group: "scenarios",
    variant: "ours",
    description:
      "One run, eight rows. Scrub the distance to watch bodies shrink from 6 rows to 1, then fold into a group. The live thinking block stays pinned.",
    states: Array.from({ length: 9 }, (_, offset) => ({
      id: `d${offset}`,
      label: `distance ${offset}`,
      render: (ctx) => decayStack(ctx, offset),
      reveal: (ctx) => decayReveal(ctx, offset),
    })),
  },
];

// ---------------------------------------------------------------------------
// Session replay: one script, two renderers, one playhead
// ---------------------------------------------------------------------------

/** Session lanes render at a fixed width and height so the eye can stay put. */
const SESSION_WIDTH = 80;

/** A step's shape as the planner sees it; a partial failure is not final yet. */
function stepShape(step: SessionStep, index: number, frame: PlaybackFrame): BlockShape {
  if (step.kind === "thinking") return { cls: "thinking" };
  if (step.kind === "tool") {
    const failed = index === frame.step ? !frame.partial && step.tool.failed : step.tool.failed;
    return { cls: toolMeta(step.tool.name).cls, failed };
  }
  return { cls: "prose" };
}

/** What a step shows at this frame: complete for past steps, streamed for the live one. */
function stepProgress(step: SessionStep, index: number, frame: PlaybackFrame) {
  const live = index === frame.step;
  if (step.kind === "prefill") {
    return { live, chars: 0, lines: 0, partial: false };
  }
  if (step.kind === "tool") {
    const outputLines = (step.tool.output ?? "").split("\n").length;
    return {
      live,
      chars: live ? frame.chars : (step.tool.title ?? "").length,
      lines: live ? frame.lines : outputLines,
      partial: live ? frame.partial : false,
    };
  }
  return {
    live,
    chars: live ? frame.chars : step.text.length,
    lines: 0,
    partial: live ? frame.partial : false,
  };
}

/** Bare pi: append everything, preview caps only, thinking collapses on completion. */
function sessionBase(ctx: RenderCtx, frameIndex: number): string[] {
  const frame = PLAYBACK[frameIndex];
  if (!frame) throw new Error(`session frame ${frameIndex} out of range`);
  const steps = SESSION_STEPS.slice(0, frame.step + 1);
  const components = steps.map((step, index) => {
    const progress = stepProgress(step, index, frame);
    switch (step.kind) {
      case "prefill":
        return ctx.kit.component(() => []);
      case "user":
        return new ctx.pi.modules.coding.UserMessageComponent(
          partialText(step.text, progress.chars),
          ctx.pi.modules.coding.getMarkdownTheme(),
          1,
        );
      case "thinking":
        return baseAssistant(ctx.pi, [{ type: "thinking", thinking: partialText(step.text, progress.chars) }], true);
      case "text":
        return baseAssistant(ctx.pi, [{ type: "text", text: partialText(step.text, progress.chars) }], false);
      case "tool": {
        const key = streamingArgKey(step.tool.name);
        const fullArg = String(step.tool.args[key] ?? "");
        const streamedArgs = { ...step.tool.args };
        if (progress.partial && progress.chars < fullArg.length) streamedArgs[key] = fullArg.slice(0, progress.chars);
        const output = partialLines(step.tool.output ?? "", progress.lines);
        return baseToolStreaming(ctx.pi, step.tool.name, streamedArgs, output, {
          argsComplete: progress.chars >= fullArg.length,
          partial: progress.partial,
          isError: !progress.partial && (step.tool.failed ?? false),
        });
      }
    }
  });
  return stack(SESSION_WIDTH, components);
}

/** Ours: the same events, aged by distance from the tail, streaming as they land. */
interface SessionPiece {
  lines: string[];
  opens?: string[][];
  key?: string;
}

function sessionPieces(ctx: RenderCtx, frameIndex: number): SessionPiece[] {
  const frame = PLAYBACK[frameIndex];
  if (!frame) throw new Error(`session frame ${frameIndex} out of range`);
  const steps = SESSION_STEPS.slice(0, frame.step + 1);
  const plan = planTranscript(steps.map((step, index) => stepShape(step, index, frame)));

  return plan.map((item) => {
    if (item.kind === "group") {
      return { lines: renderGroupRow(ours(ctx), { segments: item.segments }).render(SESSION_WIDTH) };
    }

    const step = steps[item.index];
    if (!step) throw new Error(`session frame ${frameIndex}: missing step ${item.index}`);
    const progress = stepProgress(step, item.index, frame);
    const live = progress.partial && progress.live;

    switch (step.kind) {
      case "prefill":
        return { lines: [] };
      case "user":
        return {
          lines: new ctx.pi.modules.coding.UserMessageComponent(
            partialText(step.text, progress.chars),
            ctx.pi.modules.coding.getMarkdownTheme(),
            1,
          ).render(SESSION_WIDTH),
        };
      case "text":
        return {
          lines: baseAssistant(ctx.pi, [{ type: "text", text: partialText(step.text, progress.chars) }], false).render(
            SESSION_WIDTH,
          ),
        };
      case "thinking": {
        const text = partialText(step.text, progress.chars);
        const label = thinkingLabel(ours(ctx), {
          phase: live ? "thinking" : "done",
          level: item.level,
          text,
          width: SESSION_WIDTH,
          durationMs: live ? undefined : 1200,
          frame: frameIndex % 10,
        });
        const piece: SessionPiece = { lines: thinkingBlock(ctx, label).render(SESSION_WIDTH) };
        if (!live) {
          const expandedLines = thinkingLabel(ours(ctx), {
            phase: "done",
            level: 0,
            text,
            width: SESSION_WIDTH,
            durationMs: 1200,
            frame: frameIndex % 10,
            expanded: true,
          }).split("\n");
          if (expandedLines.length > piece.lines.length) piece.opens = [expandedLines];
        }
        if (piece.opens) piece.key = `think:${item.index}`;
        return piece;
      }
      case "tool": {
        const input: ToolRowInput = {
          name: step.tool.name,
          args: step.tool.args,
          status: progress.partial ? "running" : step.tool.failed ? "error" : "success",
          level: item.level,
          title: partialText(step.tool.title ?? "", progress.chars),
          summary: progress.partial ? "" : step.tool.summary,
          output: partialLines(step.tool.output ?? "", progress.lines),
          durationMs: progress.partial ? undefined : step.tool.durationMs,
          frame: frameIndex % 10,
        };
        const piece: SessionPiece = { lines: renderToolRow(ours(ctx), input).render(SESSION_WIDTH) };
        if (!progress.partial) {
          const capped = renderToolRow(ours(ctx), { ...input, expanded: true }).render(SESSION_WIDTH);
          const whole = renderToolRow(ours(ctx), { ...input, full: true }).render(SESSION_WIDTH);
          // A row only offers opening when opening reveals rows it is hiding.
          if (capped.length > piece.lines.length) {
            piece.opens = whole.length > capped.length ? [capped, whole] : [capped];
            piece.key = `tool:${item.index}`;
          }
        }
        return piece;
      }
    }
  });
}

/** Strip SGR and OSC to ask the only question a gap cares about: is there text? */
// oxlint-disable-next-line no-control-regex -- escape sequences are the input domain
const ANSI_ONLY = /\x1b\[[\d;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex -- same domain: detecting marker rows
const ESCAPE = /\x1b/g;
const visibleText = (line: string): string => line.replace(ANSI_ONLY, "").trim();
const hasText = (line: string): boolean => visibleText(line) !== "";

/**
 * Pi pads its components and emits OSC 133 prompt markers on rows of their own.
 * Both show up as blank rows here: drop the marker rows, trim the padding, and
 * leave the one gap the transcript itself adds.
 */
function trimEdgeBlanks(lines: string[]): string[] {
  const kept = lines.filter((line) => !(visibleText(line) === "" && ESCAPE.test(line)));
  let start = 0;
  let end = kept.length;
  while (start < end && !hasText(kept[start] ?? "")) start++;
  while (end > start && !hasText(kept[end - 1] ?? "")) end--;
  return kept.slice(start, end);
}

/** Lay pieces out like the transcript: one blank row between blocks. */
function arrangePieces(pieces: SessionPiece[], gap = 1): { lines: string[]; toggles: ToggleSpec[] } {
  const lines: string[] = [];
  const toggles: ToggleSpec[] = [];
  // An empty piece (a text delta with no characters yet) must not claim a gap.
  const visible = pieces
    .map((piece) => ({ piece, body: trimEdgeBlanks(piece.lines) }))
    .filter(({ body }) => body.length > 0);
  visible.forEach(({ piece, body }, index) => {
    if (index > 0) for (let row = 0; row < gap; row++) lines.push("");
    const row = lines.length;
    lines.push(...body);
    if (piece.opens && piece.key) {
      toggles.push({ row, count: body.length, opens: piece.opens, key: piece.key });
    }
  });
  return { lines, toggles };
}

function sessionOurs(ctx: RenderCtx, frameIndex: number): string[] {
  return arrangePieces(sessionPieces(ctx, frameIndex)).lines;
}

function sessionToggles(ctx: RenderCtx, frameIndex: number): ToggleSpec[] {
  return arrangePieces(sessionPieces(ctx, frameIndex)).toggles;
}

/**
 * What a click on a folded run opens: a header row plus every member as a block
 * that can itself be expanded (body) or collapsed (header only).
 */
function sessionReveal(ctx: RenderCtx, frameIndex: number): RevealGroup[] {
  const frame = PLAYBACK[frameIndex];
  if (!frame) throw new Error(`session frame ${frameIndex} out of range`);
  const steps = SESSION_STEPS.slice(0, frame.step + 1);
  const plan = planTranscript(steps.map((step, index) => stepShape(step, index, frame)));

  return plan.flatMap((item) => {
    if (item.kind !== "group") return [];
    const header = renderGroupRow(ours(ctx), { segments: item.segments, expanded: true }).render(SESSION_WIDTH);
    const members: RevealMember[] = item.indices.flatMap((index) => {
      const step = steps[index];
      if (!step || step.kind !== "tool") return [];
      const input: ToolRowInput = {
        name: step.tool.name,
        args: step.tool.args,
        status: step.tool.failed ? "error" : "success",
        title: step.tool.title,
        summary: step.tool.summary,
        output: step.tool.output,
        durationMs: step.tool.durationMs,
        level: 4,
      };
      const collapsed = renderToolLine(ours(ctx), input).render(SESSION_WIDTH);
      const preview = renderToolRow(ours(ctx), input).render(SESSION_WIDTH);
      const expanded = renderToolRow(ours(ctx), { ...input, expanded: true }).render(SESSION_WIDTH);
      return [
        {
          collapsed,
          preview:
            expanded.length > preview.length
              ? [...preview, ours(ctx).theme.fg("dim", `▸ show all ${expanded.length} lines`)]
              : collapsed,
          expanded,
        },
      ];
    });
    return [{ header, members }];
  });
}

const sessionEntries: EntryDef[] = [
  {
    id: "session.base",
    title: "Bare pi",
    group: "session",
    variant: "base",
    description: "Thinking collapses to one label; every tool block keeps its full preview, and the box padding stays.",
    sync: "session",
    stage: "session",
    frameLabels: FRAME_LABELS,
    frameCosts: PLAYBACK.map((frame) => frame.ms),
    fixedWidth: SESSION_WIDTH,
    fixture: false,
    states: [{ id: "default", label: "replay", frames: PLAYBACK.length, render: sessionBase }],
  },
  {
    id: "session.ours",
    title: "pi-prism",
    group: "session",
    variant: "ours",
    description: "The same frames graded by distance: bodies shrink, runs fold, failures keep their own line.",
    sync: "session",
    stage: "session",
    frameLabels: FRAME_LABELS,
    frameCosts: PLAYBACK.map((frame) => frame.ms),
    fixedWidth: SESSION_WIDTH,
    fixture: false,
    states: [
      {
        id: "default",
        label: "replay",
        frames: PLAYBACK.length,
        render: sessionOurs,
        reveal: sessionReveal,
        toggles: sessionToggles,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Glyph studies: what a block icon could be, and how a running one moves
// ---------------------------------------------------------------------------

interface IconOption {
  label: string;
  note: string;
  icons: Array<{ name: string; icon: string }>;
}

const ICON_OPTIONS: Record<string, IconOption> = {
  shapes: {
    label: "Shape-coded",
    note: "Each taxonomy gets its own silhouette: the icon says what kind of work this is.",
    icons: [
      { name: "read", icon: "◔" },
      { name: "search", icon: "⌕" },
      { name: "write", icon: "✚" },
      { name: "edit", icon: "✎" },
      { name: "bash", icon: "❯" },
      { name: "web", icon: "⌁" },
      { name: "memory/search", icon: "⬡" },
      { name: "generic", icon: "◇" },
    ],
  },
  rings: {
    label: "Status rings",
    note: "The icon reports outcome, not kind: one vocabulary for every tool, read at a glance.",
    icons: [
      { name: "pending · queued", icon: "○" },
      { name: "running · in flight", icon: "◐" },
      { name: "success · done", icon: "●" },
      { name: "expanded · pinned", icon: "◉" },
      { name: "error · failed", icon: "✕" },
      { name: "group · folded", icon: "▸" },
    ],
  },
  nerd: {
    label: "Nerd font",
    note: "Powerline glyphs if the terminal font ships them; falls back to tofu elsewhere.",
    icons: [
      { name: "read", icon: "󰈔" },
      { name: "search", icon: "󰍉" },
      { name: "write", icon: "󰏫" },
      { name: "edit", icon: "󰏬" },
      { name: "bash", icon: "󰆍" },
      { name: "web", icon: "󰖟" },
      { name: "memory/search", icon: "󰒍" },
      { name: "generic", icon: "󰇙" },
    ],
  },
  marker: {
    label: "Single marker",
    note: "What ships today: one dot for every tool, kind and outcome live in the words.",
    icons: [
      { name: "read", icon: "●" },
      { name: "search", icon: "●" },
      { name: "edit", icon: "●" },
      { name: "bash", icon: "●" },
      { name: "web", icon: "●" },
      { name: "memory/search", icon: "●" },
      { name: "pending", icon: "○" },
      { name: "error", icon: "✗" },
    ],
  },
};

function iconSheet(ctx: RenderCtx, option: IconOption): string[] {
  return option.icons.map(({ name, icon }) => {
    const head = `${ctx.theme.fg("accent", icon)} ${ctx.theme.fg("toolTitle", name)}`;
    const tail = ctx.theme.fg("dim", "· src/core/session.ts · 64 lines · 0.2s");
    return ctx.kit.truncateToWidth(`${head} ${tail}`, ctx.width, "…");
  });
}

interface MotionOption {
  label: string;
  note: string;
  frames: string[];
}

const MOTION_OPTIONS: Record<string, MotionOption> = {
  braille: {
    label: "Braille orbit",
    note: "Ships today: ten frames, smooth on every mono font.",
    frames: [...glyphsFor("unicode").spinner],
  },
  quarter: {
    label: "Quarter circle",
    note: "Four frames: the crispest geometric sweep, no dot noise.",
    frames: ["◜", "◝", "◞", "◟"],
  },
  blocks: {
    label: "Rising blocks",
    note: "Eight frames: reads as work accumulating rather than spinning.",
    frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  },
  orbit: {
    label: "Orbit pulse",
    note: "Four frames: a bead circling into and out of view.",
    frames: ["·", "•", "●", "•"],
  },
  arrows: {
    label: "Compass",
    note: "Eight frames: direction of travel, good for long-running tools.",
    frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"],
  },
  moon: {
    label: "Moon phases",
    note: "Eight frames: calm, but emoji width can break the column.",
    frames: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
  },
  nerd: {
    label: "Nerd spinner",
    note: "Four frames from the nerd-font set; needs the patched font.",
    frames: [...glyphsFor("nerd").spinner],
  },
};

function motionSheet(ctx: RenderCtx, option: MotionOption, frame: number): string[] {
  const glyph = option.frames[frame % option.frames.length] ?? "";
  const think = `${ctx.theme.fg("accent", glyph)} ${ctx.theme.fg("toolTitle", "think")}`;
  const thought = ctx.theme.italic(ctx.theme.fg("thinkingText", "  Watching the tail while the output still arrives."));
  const tool = `${ctx.theme.fg("accent", glyph)} ${ctx.theme.fg("toolTitle", "bash")} ${ctx.theme.fg("dim", "· bun test · running")}`;
  return [
    think,
    thought,
    "",
    tool,
    ctx.theme.fg("toolOutput", "  $ bun test --watch"),
    ctx.theme.fg("dim", "  waiting for the first failure"),
  ].map((line) => ctx.kit.truncateToWidth(line, ctx.width, "…"));
}

const glyphEntries: EntryDef[] = [
  {
    id: "glyph.icons",
    title: "Icon sets",
    group: "glyphs",
    variant: "ours",
    description:
      "Four candidates for the block icon: shape-coded by taxonomy, status rings, nerd font, or today's single marker. Chips switch candidate.",
    states: Object.entries(ICON_OPTIONS).map(([id, option]) => ({
      id,
      label: option.label,
      note: option.note,
      render: (ctx) => iconSheet(ctx, option),
    })),
  },
  {
    id: "glyph.motion",
    title: "Animations",
    group: "glyphs",
    variant: "ours",
    description:
      "Seven spinners for a running block. Motion is on: each candidate animates in place, so compare them side by side.",
    states: Object.entries(MOTION_OPTIONS).map(([id, option]) => ({
      id,
      label: option.label,
      note: option.note,
      frames: option.frames.length,
      render: (ctx, frame) => motionSheet(ctx, option, frame),
    })),
  },
];

export const ENTRIES: EntryDef[] = [
  ...sessionEntries,
  ...baseEntries,
  ...oursEntries,
  ...glyphEntries,
  ...scenarioEntries,
];

export const WIDTHS = [40, 60, 80, 100, 120] as const;
export const GLYPH_MODES: GlyphMode[] = ["unicode", "ascii"];
export const THEME_NAMES = ["dark", "light"] as const;

export function glyphsForCtx(mode: GlyphMode): GlyphSet {
  return glyphsFor(mode);
}
