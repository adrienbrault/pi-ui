/**
 * Component registry: every card is a render function over real components.
 * The golden fixtures and `bun run ds:show` both derive from this file.
 */

import { formatDuration } from "../packages/pi-prism/render/text.ts";
import type { GlyphSet, GlyphMode } from "../packages/pi-prism/render/glyphs.ts";
import { glyphsFor } from "../packages/pi-prism/render/glyphs.ts";
import { groupSegments, renderGroupMember, renderGroupRow } from "../packages/pi-prism/render/group-row.ts";
import { cutMark, type RenderKit } from "../packages/pi-prism/render/kit.ts";
import type { DetailLevel } from "../packages/pi-prism/render/detail.ts";
import { COMPACT_LEVEL, FOLD_DISTANCE } from "../packages/pi-prism/render/detail.ts";
import { blockDistances, type PlanBlock } from "../packages/pi-prism/render/layout.ts";
import {
  type FoldUnit,
  planFolds,
  resetFolds,
  setGroupOpen,
  thinkingPlan,
  toolPlan,
} from "../packages/pi-prism/extensions/fold.ts";
import { thinkingLabel } from "../packages/pi-prism/render/thinking.ts";
import { renderToolRow, toolHeader, type ToolRowInput } from "../packages/pi-prism/render/tool-row.ts";
import {
  callTokens,
  estimatedTokens,
  toolTokenCounts,
  toolMeta,
  toolTokenLabel,
} from "../packages/pi-prism/render/tools.ts";
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
export type Group = "transcript" | "tools" | "thinking" | "groups" | "glyphs" | "scenarios";

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
}

export interface EntryDef {
  id: string;
  title: string;
  group: Group;
  variant: Variant;
  description: string;
  states: StateDef[];
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

function baseAssistant(
  pi: PiInstall,
  content: unknown[],
  hideThinking: boolean,
  label = "Thinking...",
  padding = 1,
): any {
  return new pi.modules.coding.AssistantMessageComponent(
    assistantMessage(content),
    hideThinking,
    pi.modules.coding.getMarkdownTheme(),
    label,
    padding,
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
            durationMs: frame * 100,
            frame,
          });
          return baseAssistant(ctx.pi, [{ type: "thinking", thinking: THINKING_TEXT }], true, label).render(ctx.width);
        },
      },
      {
        id: "markdown",
        label: "expanded Markdown",
        render: (ctx) =>
          thinkingLabel(ours(ctx), {
            phase: "done",
            level: 0,
            expanded: true,
            text: [
              "**Check the return value**",
              "",
              "- Inspect `render()`.",
              "",
              "```ts",
              "const rows = render(80);",
              "```",
            ].join("\n"),
            width: ctx.width,
          }).split("\n"),
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
      levelState("l0", "success L0", 0, () => readRow({ outputRate: 48, inputRate: 2400 })),
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
              durationMs: frame * 100,
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
    description:
      "Collapsed rows become one sentence. Thinking reads as time and shell commands carry their runtime when every member was timed. Failures keep their own count.",
    states: [
      {
        id: "collapsed",
        label: "collapsed",
        render: (ctx) =>
          renderGroupRow(ours(ctx), {
            tokens: { outputTokens: 135, inputTokens: 2840 },
            segments: groupSegments([
              { cls: "thinking", count: 2, durationMs: 41_000 },
              { cls: "read" },
              { cls: "read" },
              { cls: "list" },
              { cls: "shell", durationMs: 8100 },
              { cls: "shell", durationMs: 1200 },
              { cls: "edit" },
            ]),
            durationMs: 63_000,
          }).render(ctx.width),
      },
      {
        id: "expanded",
        label: "expanded",
        render: (ctx) =>
          renderGroupRow(ours(ctx), {
            tokens: { outputTokens: 135, inputTokens: 2840 },
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
            tokens: { outputTokens: 135, inputTokens: 2840 },
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
  { ...readRow({ title: "src/core/session.ts" }), key: "read-1" },
  { ...readRow({ title: "src/modes/interactive/interactive-mode.js" }), key: "read-2" },
  { ...bashRow({ title: "rg -n 'registerToolRenderer' src", output: SHELL_OK }), key: "bash-1" },
  { ...editRow({ title: "extensions/prism/decorator.ts", summary: "+42 −7" }), key: "edit-1" },
  {
    ...readRow({ title: "src/modes/interactive/components/assistant-message.js" }),
    key: "read-3",
  },
  { ...editRow({ title: "extensions/prism/thinking.ts", summary: "+18 −3" }), key: "edit-2" },
  { ...bashRow({ title: "bun test", output: SHELL_OK, durationMs: 8100 }), key: "bash-2" },
  { ...mcpRow({ title: "memory/search" }), key: "mcp-1" },
];

const planOf = (unit: FoldUnit) => (unit.kind === "tool" ? toolPlan(unit.key) : thinkingPlan(unit.component));

/** A scripted transcript block. Tools and thoughts are planned; the rest anchor. */
type ScenarioBlock =
  | { kind: "tool"; row: ScenarioRow; startedAt?: number }
  | { kind: "thinking"; key: string; text: string; durationMs: number; startedAt?: number }
  | { kind: "prose"; text: string }
  | { kind: "user"; text: string };

type Rendered = { render(width: number): string[] };

/**
 * Plan a scripted run with `planFolds`, the module the live session uses, and
 * stack what it decides: a block at its level, or one summary where a group
 * starts, with one row per member under it when the group is open. `offset`
 * ages every block, as later blocks would.
 */
function plannedStack(
  ctx: RenderCtx,
  blocks: ScenarioBlock[],
  { offset = 0, open = false }: { offset?: number; open?: boolean } = {},
): Rendered[] {
  const api = ours(ctx);
  const distances = blockDistances(
    blocks.map(
      (block): PlanBlock => (block.kind === "tool" || block.kind === "thinking" ? { kind: block.kind } : block),
    ),
  );
  // Thought plans are keyed by component: fresh objects keep cells independent.
  const units = new Map<ScenarioBlock, FoldUnit>();
  blocks.forEach((block, index) => {
    if (block.kind !== "tool" && block.kind !== "thinking") return;
    const { distance, startsRun, currentRun } = distances[index]!;
    const durationMs = block.kind === "tool" ? block.row.durationMs : block.durationMs;
    const timing =
      block.startedAt !== undefined && durationMs !== undefined
        ? { startedAt: block.startedAt, endedAt: block.startedAt + durationMs }
        : {};
    units.set(block, {
      kind: block.kind,
      key: block.kind === "tool" ? block.row.key : block.key,
      component: {},
      count: 1,
      cls: block.kind === "tool" ? toolMeta(block.row.name).cls : "thinking",
      failed: block.kind === "tool" && block.row.status === "error",
      tokens:
        block.kind === "tool"
          ? toolTokenCounts(block.row)
          : { outputTokens: estimatedTokens(block.text.length), inputTokens: 0 },
      activeMs: durationMs,
      ...timing,
      distance: Math.min(FOLD_DISTANCE, offset + distance),
      startsRun,
      currentRun,
      invalidate: () => {},
    });
  });
  resetFolds();
  planFolds([...units.values()]);
  for (const unit of units.values()) {
    const group = planOf(unit)?.group;
    if (open && group && !group.open) setGroupOpen(group, true);
  }

  const thought = (block: Extract<ScenarioBlock, { kind: "thinking" }>, level: DetailLevel, width: number) =>
    thinkingLabel(api, { phase: "aged", level, text: block.text, width, durationMs: block.durationMs }).split("\n");
  const member = (block: ScenarioBlock, width: number): string[] =>
    renderGroupMember(
      ctx.kit,
      width,
      (inner) =>
        block.kind === "tool"
          ? [toolHeader(api, { ...block.row, level: COMPACT_LEVEL }, inner).line]
          : block.kind === "thinking"
            ? thought(block, COMPACT_LEVEL, inner)
            : [],
      cutMark(api.theme),
    );

  const components: Rendered[] = [];
  for (const block of blocks) {
    if (block.kind === "user") {
      components.push(
        new ctx.pi.modules.coding.UserMessageComponent(block.text, ctx.pi.modules.coding.getMarkdownTheme(), 1),
      );
      continue;
    }
    if (block.kind === "prose") {
      components.push(baseAssistant(ctx.pi, [{ type: "text", text: block.text }], true));
      continue;
    }
    const unit = units.get(block)!;
    const plan = planOf(unit);
    if (plan?.mode === "hidden") continue;
    const group = plan?.group;
    if (plan?.mode === "anchor" && group) {
      const members = blocks.filter((candidate) => {
        const candidateUnit = units.get(candidate);
        return candidateUnit && group.members.some((item) => item.component === candidateUnit.component);
      });
      components.push(
        ctx.kit.component((width) => [
          ...renderGroupRow(api, {
            segments: group.segments,
            tokens: group.tokens,
            expanded: group.open,
            // Untimed scripts read as the summed run time.
            durationMs: group.durationMs ?? group.members.reduce((sum, item) => sum + (item.activeMs ?? 0), 0),
          }).render(width),
          // Members stack under the summary with no blank rows, as they do live.
          ...(group.open ? members.flatMap((item) => member(item, width)) : []),
        ]),
      );
      continue;
    }
    const level = plan?.level ?? 0;
    components.push(
      block.kind === "tool"
        ? renderToolRow(api, { ...block.row, level })
        : thinkingBlock(
            ctx,
            thinkingLabel(api, {
              phase: "aged",
              level,
              text: block.text,
              width: ctx.width,
              durationMs: block.durationMs,
            }),
          ),
    );
  }
  return components;
}

function decayStack(ctx: RenderCtx, offset: number): string[] {
  const components = plannedStack(
    ctx,
    decayRows.map((row) => ({ kind: "tool", row })),
    { offset },
  );

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

/** A finished run, then a new prompt: the older run folds into one mixed group. */
const foldRun: ScenarioBlock[] = [
  {
    kind: "thinking",
    key: "plan",
    text: "Start from the planner.\n**choosing where the fold starts**",
    durationMs: 4200,
    startedAt: 0,
  },
  { kind: "tool", row: { ...readRow({ title: "extensions/fold.ts" }), key: "fold-read" }, startedAt: 4300 },
  {
    kind: "tool",
    row: {
      name: "grep",
      args: { pattern: "planFolds", path: "packages" },
      status: "success",
      level: 0,
      title: "planFolds in packages",
      output: "extensions/fold.ts:210\nextensions/thinking.ts:744",
      durationMs: 60,
      key: "fold-grep",
    },
    startedAt: 4700,
  },
  {
    kind: "tool",
    row: {
      ...bashRow({ title: "bun test fold", status: "error", error: "1 fail\nexit code 1", durationMs: 900 }),
      key: "fold-bash",
    },
    startedAt: 4800,
  },
  {
    kind: "thinking",
    key: "retry",
    text: "The test pinned the old tail.\n**after a failed call, fix the literal**",
    durationMs: 2100,
    startedAt: 5800,
  },
  {
    kind: "tool",
    row: { ...editRow({ title: "extensions/fold.test.ts", summary: "+1 −1" }), key: "fold-edit" },
    startedAt: 8000,
  },
  { kind: "prose", text: "The planner tests pass at the default tail." },
  { kind: "user", text: "Now plan the fixtures with it." },
  {
    kind: "thinking",
    key: "next",
    text: "**the fixtures should call planFolds**",
    durationMs: 1500,
    startedAt: 20_000,
  },
  { kind: "tool", row: { ...readRow({ title: "design-system/registry.ts" }), key: "next-read" }, startedAt: 21_600 },
];

const scenarioEntries: EntryDef[] = [
  {
    id: "scenario.decay",
    title: "Decay ladder",
    group: "scenarios",
    variant: "ours",
    description: "Nine distances from the tail: older previews shrink and fold into a group.",
    states: Array.from({ length: 9 }, (_, offset) => ({
      id: `d${offset}`,
      label: `distance ${offset}`,
      render: (ctx) => decayStack(ctx, offset),
    })),
  },
  {
    id: "scenario.fold",
    title: "Mixed group",
    group: "scenarios",
    variant: "ours",
    description:
      "A finished run folds thoughts and tools, a failure among them, into one summary; opening it lists every member.",
    states: [
      { id: "collapsed", label: "collapsed", render: (ctx) => stack(ctx.width, plannedStack(ctx, foldRun), 1) },
      {
        id: "opened",
        label: "opened",
        render: (ctx) => stack(ctx.width, plannedStack(ctx, foldRun, { open: true }), 1),
      },
      {
        id: "forming",
        label: "forming",
        note: "Five blocks later: the new run's first group lists its members until it holds six rows.",
        render: (ctx) => stack(ctx.width, plannedStack(ctx, foldRun, { offset: FOLD_DISTANCE }), 1),
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
  ascii: {
    label: "ASCII safe",
    note: "Every glyph is a printable ASCII char: identical on any font, any terminal.",
    icons: [
      { name: "read", icon: ">" },
      { name: "search", icon: "?" },
      { name: "write", icon: "+" },
      { name: "edit", icon: "*" },
      { name: "bash", icon: "$" },
      { name: "web", icon: "@" },
      { name: "memory/search", icon: "#" },
      { name: "generic", icon: "%" },
    ],
  },
  geometric: {
    label: "Geometric",
    note: "Open shapes for nouns, filled for verbs: reads as a diagram, not an emoji set.",
    icons: [
      { name: "read", icon: "▷" },
      { name: "search", icon: "◌" },
      { name: "write", icon: "◆" },
      { name: "edit", icon: "◇" },
      { name: "bash", icon: "❯" },
      { name: "web", icon: "◈" },
      { name: "memory/search", icon: "⬢" },
      { name: "generic", icon: "▫" },
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

/** All icon candidates in one card: labels, then four icons per row. */
function iconsAllSheet(ctx: RenderCtx, frame = 0): string[] {
  const rows: string[] = [];
  let cell = 0;
  for (const option of Object.values(ICON_OPTIONS)) {
    rows.push(ctx.theme.style(option.label, { fg: "toolTitle", bold: true }));
    const cells = option.icons.map(({ name, icon }) => {
      const tone = TONES[(cell++ + frame) % TONES.length] ?? "accent";
      return `${ctx.theme.fg(tone, icon)} ${ctx.theme.fg("toolOutput", name)}`;
    });
    for (let at = 0; at < cells.length; at += 4) {
      rows.push(`  ${cells.slice(at, at + 4).join("   ")}`);
    }
  }
  return rows.map((line) => ctx.kit.truncateToWidth(line, ctx.width, "…"));
}

/** Every spinner in one card, all animating at once: compare, then pick. */
function motionsAllSheet(ctx: RenderCtx, frame: number): string[] {
  return Object.values(MOTION_OPTIONS).flatMap((option) => {
    const glyph = option.frames[frame % option.frames.length] ?? "";
    const head = `${ctx.theme.fg(toneAt(option, frame), glyph)} ${ctx.theme.style(option.label, { fg: "toolTitle", bold: true })}`;
    const tail = ctx.theme.fg("dim", `· ${option.frames.length} frames`);
    return [ctx.kit.truncateToWidth(`${head} ${tail}`, ctx.width, "…")];
  });
}

function iconSheet(ctx: RenderCtx, option: IconOption): string[] {
  return option.icons.map(({ name, icon }) => {
    const head = `${ctx.theme.fg("accent", icon)} ${ctx.theme.fg("toolTitle", name)}`;
    const path = "src/core/session.ts";
    const tokens = toolTokenLabel(callTokens(name, { path }), estimatedTokens(FILE_TEXT.length));
    const tail = ctx.theme.fg("dim", `· ${path} · ${tokens} · ${formatDuration(200)}`);
    return ctx.kit.truncateToWidth(`${head} ${tail}`, ctx.width, "…");
  });
}

interface MotionOption {
  label: string;
  note: string;
  frames: string[];
  /** Optional per-frame colour: the same glyph can warm up as work advances. */
  colors?: string[];
}

/** Colour for a frame, or the calm accent when the option is monochrome. */
function toneAt(option: MotionOption, frame: number): string {
  return option.colors?.[frame % option.colors.length] ?? "accent";
}

/** A colour sweep across a row of icons: the glyphs breathe while motion is on. */
const TONES = ["accent", "muted", "toolOutput", "success", "warning", "muted"] as const;

const MOTION_OPTIONS: Record<string, MotionOption> = {
  braille: {
    label: "Braille orbit",
    note: "Ships today: ten frames, smooth on every mono font.",
    frames: [...glyphsFor("unicode").spinner],
    colors: [
      "accent",
      "accent",
      "toolOutput",
      "success",
      "success",
      "toolOutput",
      "accent",
      "accent",
      "accent",
      "accent",
    ],
  },
  quarter: {
    label: "Quarter circle",
    note: "Four frames: the crispest geometric sweep, no dot noise.",
    frames: ["◜", "◝", "◞", "◟"],
    colors: ["accent", "toolOutput", "success", "toolOutput"],
  },
  blocks: {
    label: "Rising blocks",
    note: "Eight frames: reads as work accumulating rather than spinning.",
    frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
    colors: ["dim", "muted", "accent", "toolOutput", "success", "toolOutput", "accent", "muted"],
  },
  orbit: {
    label: "Orbit pulse",
    note: "Four frames: a bead circling into and out of view.",
    frames: ["·", "•", "●", "•"],
    colors: ["dim", "muted", "accent", "toolOutput"],
  },
  arrows: {
    label: "Compass",
    note: "Eight frames: direction of travel, good for long-running tools.",
    frames: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"],
  },
  shade: {
    label: "Shade breathe",
    note: "Six frames of ░▒▓█: reads as pressure building, not rotation (from agents-are-thinking).",
    frames: ["░", "▒", "▓", "█", "▓", "▒"],
    colors: ["dim", "muted", "accent", "success", "accent", "muted"],
  },
  seesaw: {
    label: "Bar seesaw",
    note: "One column of a bar wave: ▁▃▅▇▅▃ — the repo's BarSeeSaw collapsed to a single cell.",
    frames: ["▁", "▃", "▅", "▇", "▅", "▃"],
    colors: ["dim", "muted", "accent", "toolOutput", "accent", "muted"],
  },
  square: {
    label: "Square sweep",
    note: "Four quadrants rotating: the repo's Square family as one glyph.",
    frames: ["◰", "◳", "◲", "◱"],
    colors: ["accent", "toolOutput", "success", "accent"],
  },
  scanner: {
    label: "Scanner",
    note: "A sweep that grows and returns: reads as measuring rather than waiting.",
    frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"],
    colors: [
      "dim",
      "muted",
      "accent",
      "accent",
      "toolOutput",
      "toolOutput",
      "success",
      "success",
      "success",
      "toolOutput",
      "accent",
      "accent",
      "muted",
      "dim",
    ],
  },
  ripple: {
    label: "Ripple",
    note: "A dot opening and closing: the repo's Ripple, reduced to one column.",
    frames: ["·", "○", "◔", "◐", "◕", "●", "◕", "◐", "◔", "○"],
    colors: ["dim", "muted", "accent", "toolOutput", "success", "success", "toolOutput", "accent", "muted", "dim"],
  },
  progress: {
    label: "Progress tint",
    note: "The bar rises while its colour warms from dim to success: progress and outcome in one cell.",
    frames: ["▁", "▃", "▅", "▇", "█", "▇", "▅", "▃"],
    colors: ["dim", "muted", "accent", "toolOutput", "success", "toolOutput", "accent", "muted"],
  },
  glimmer: {
    label: "Glimmer",
    note: "A four-point star that catches light: calm enough for long reads, alive while it waits.",
    frames: ["✦", "✧", "✦", "✧"],
    colors: ["dim", "accent", "toolOutput", "accent"],
  },
  heat: {
    label: "Heat gauge",
    note: "One dot carrying the temperature of the run: success, warning, then error when it fails.",
    frames: ["●", "◉", "●", "◉"],
    colors: ["success", "warning", "warning", "error"],
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
  const tone = toneAt(option, frame);
  const think = `${ctx.theme.fg(tone, glyph)} ${ctx.theme.fg("toolTitle", "think")}`;
  const thought = ctx.theme.italic(
    ctx.theme.fg(tone === "accent" ? "thinkingText" : tone, "  Watching the tail while the output still arrives."),
  );
  const tool = `${ctx.theme.fg(tone, glyph)} ${ctx.theme.fg("toolTitle", "bash")} ${ctx.theme.fg("dim", "· bun test · running")}`;
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
    id: "lab.icons.all",
    title: "Every icon candidate",
    group: "glyphs",
    variant: "ours",
    description:
      "All icon sets at once, four per row. Same sample names, so the only variable is the glyph vocabulary.",
    states: [
      {
        id: "all",
        label: "all sets",
        frames: 12,
        render: (ctx, frame) => iconsAllSheet(ctx, frame),
      },
    ],
  },
  {
    id: "lab.motions.all",
    title: "Every spinner at once",
    group: "glyphs",
    variant: "ours",
    description:
      "All single-cell animations side by side, each cycling at its own length. Paused with the motion toggle.",
    states: [
      {
        id: "all",
        label: "all motions",
        frames: Math.max(...Object.values(MOTION_OPTIONS).map((option) => option.frames.length)),
        render: (ctx, frame) => motionsAllSheet(ctx, frame),
      },
    ],
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

export const ENTRIES: EntryDef[] = [...baseEntries, ...oursEntries, ...scenarioEntries, ...glyphEntries];

export const WIDTHS = [40, 60, 80, 100, 120] as const;
export const GLYPH_MODES: GlyphMode[] = ["unicode", "ascii"];
export const THEME_NAMES = ["dark", "light"] as const;
