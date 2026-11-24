/**
 * Component registry: every card is a render function over real components.
 * The golden fixtures and `bun run ds:show` both derive from this file.
 */

import { formatDuration } from "../packages/pi-ui/render/text.ts";
import type { GlyphSet, GlyphMode } from "../packages/pi-ui/render/glyphs.ts";
import { glyphsFor } from "../packages/pi-ui/render/glyphs.ts";
import { groupSegments, renderGroupMember, renderGroupRow } from "../packages/pi-ui/render/group-row.ts";
import { cutMark, type RenderKit } from "../packages/pi-ui/render/kit.ts";
import type { DetailLevel } from "../packages/pi-ui/render/detail.ts";
import { BLOCKS_PER_STEP, COMPACT_LEVEL, FOLD_DISTANCE } from "../packages/pi-ui/render/detail.ts";
import { blockDistances, type PlanBlock } from "../packages/pi-ui/render/layout.ts";
import {
  type FoldUnit,
  planFolds,
  resetFolds,
  setGroupOpen,
  thinkingPlan,
  toolPlan,
} from "../packages/pi-ui/extensions/fold.ts";
import { thinkingLabel, thoughtCells } from "../packages/pi-ui/render/thinking.ts";
import {
  columnLabelRows,
  memberColumns,
  type ColumnLabels,
  type MemberCells,
  type MemberColumns,
} from "../packages/pi-ui/render/columns.ts";
import { renderToolRow, toolHeader, toolRowCells, type ToolRowInput } from "../packages/pi-ui/render/tool-row.ts";
import {
  callTokens,
  estimatedTokens,
  toolTokenCounts,
  toolMeta,
  toolTokenLabel,
  type CodemodeCall,
} from "../packages/pi-ui/render/tools.ts";
import { boundedPatch } from "../packages/pi-ui/extensions/changes.ts";
import { renderTodosPanel, type TodoItem } from "../packages/pi-ui/render/todos.ts";
import { restyleUserMessage } from "../packages/pi-ui/extensions/user-message.ts";
import { noticeLines } from "../packages/pi-ui/extensions/subagent-notice.ts";
import type { PiInstall } from "./lib/pi.ts";
import { stack } from "./lib/surface.ts";
import {
  EDIT_DIFF,
  FILE_TEXT,
  HASHLINE_DIFF,
  HASHLINE_READ,
  MCP_OUTPUT,
  SHELL_GREP,
  SHELL_LONG,
  SHELL_NUMBERED,
  SHELL_OK,
  SHELL_OUTPUT,
  THINKING_TEXT,
  cwd,
  editPath,
  readPath,
} from "./fixtures-data.ts";

export type Variant = "base" | "ours";
export type Group = "transcript" | "tools" | "thinking" | "groups" | "todos" | "glyphs" | "scenarios";

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

/** A path too long for a header at most widths. */
const LONG_READ_PATH = "packages/pi-ui/extensions/interaction/fixtures/sessions/thinking-and-tools.ts";

/** A script an agent writes as a heredoc: too tall for any header. */
const WRITTEN_SCRIPT = [
  "python3 - <<'PY'",
  "import json, pathlib",
  "sizes = {p.name: p.stat().st_size for p in pathlib.Path('render').glob('*.ts')}",
  "print(json.dumps(sorted(sizes.items(), key=lambda item: -item[1])[:5], indent=2))",
  "PY",
].join("\n");

/** A command long enough to wrap, over two lines, as an agent writes it. */
const OPENED_COMMAND =
  "cd packages/pi-ui && bun test render/render.test.ts extensions/interaction.test.ts --timeout 20000 --bail\nbun run typecheck";

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

/** A few lines of `render/detail.ts`, with the fold distance given. */
const detailSource = (fold: number) =>
  `export const TAIL_BUDGET = 8;\nexport const BLOCKS_PER_STEP = 2;\nexport const FOLD_DISTANCE = ${fold};\nexport const FORMING_ROWS = 5;\n`;

/**
 * A bash that wrote two files in its git work tree, as the extension records it: each patch made
 * by the extension's own `boundedPatch`, which writes patches as pi's edit tool does.
 */
const changedFilesRow = (): ToolRowInput =>
  bashRow({
    args: {
      command:
        "printf 'Edits: 5\\nLines: 12\\n' > ./tmp/one.txt; sed -i '' 's/DISTANCE = 10/DISTANCE = 12/' packages/pi-ui/render/detail.ts",
    },
    title: undefined,
    output: "(no output)",
    durationMs: 40,
    changes: {
      files: [
        {
          path: "packages/pi-ui/render/detail.ts",
          kind: "modified",
          patch: boundedPatch("packages/pi-ui/render/detail.ts", detailSource(10), detailSource(12)),
        },
        { path: "tmp/one.txt", kind: "created", patch: boundedPatch("tmp/one.txt", "", "Edits: 5\nLines: 12\n") },
      ],
    },
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

/** An edit as the model writes it: the replacement's old text, then its new text, `chars` of it so far. */
const WRITTEN_EDIT = {
  oldText: "export const FOLD_DISTANCE = 10;\nexport const FORMING_ROWS = 5;",
  newText:
    "// Blocks this far back fold into one summary row.\nexport const FOLD_DISTANCE = 12;\nexport const FORMING_ROWS = 5;",
};
const writtenEdit = (chars: number) => {
  const old = WRITTEN_EDIT.oldText.slice(0, chars);
  const rest = Math.max(0, chars - WRITTEN_EDIT.oldText.length);
  return rest ? { oldText: old, newText: WRITTEN_EDIT.newText.slice(0, rest) } : { oldText: old };
};
const WRITTEN_TOTAL = WRITTEN_EDIT.oldText.length + WRITTEN_EDIT.newText.length;

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

/** A todo call's row: the action and its row, then what the list says of it. */
const todoRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "todo",
  args: { action: "start", id: 2 },
  status: "success",
  level: 0,
  title: "start #2",
  output: "Started #2: Committing the replay harness",
  ...overrides,
});

/**
 * The question the screenshot carried: four trades off against each other. The descriptions are
 * the ones the model wrote; the chosen label keeps the `(Recommended)` the tool adds.
 */
const ASK_QUESTIONS = [
  {
    question: "What should I start with?",
    header: "Next action",
    options: [
      {
        label: "Renumber, rebase, push both PRs (Recommended)",
        description:
          "ADR 0005 → 0006, rebase this branch and adrien/template-checks onto main 0b2444bdf, force-with-lease push #1148 then #1160. Clears the collision and the player-seek flake; nothing moves in src/.",
      },
      {
        label: "Renumber and push #1148 only",
        description: "Fix the ADR number and refresh #1148, leaving #1160 on its old base until you want it rebased.",
      },
      {
        label: "Start migration step 2",
        description:
          "Leave CI/git chores and begin <twig:PageForm> and <twig:PostForm confirm>, migrating collection/edit.html.twig and Tag/rename.html.twig as the examples.",
      },
      {
        label: "Start migration step 3",
        description:
          "The scripted moves and renames (~300 files, one commit per module). The ADR wants this merged on a day few PRs are open.",
      },
    ],
  },
];

/** Two questions in one prompt: each names itself in the body, and the title counts them. */
const ASK_PAIR = [
  ASK_QUESTIONS[0]!,
  {
    question: "How should the migration land?",
    header: "Delivery",
    options: [{ label: "One commit per module" }, { label: "One branch per module" }],
  },
];

/** An ask's row: the question it asked, and the answer it came back with. */
const askRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "ask_user_question",
  args: { questions: ASK_QUESTIONS },
  status: "success",
  level: 0,
  output: "User has answered your questions: …",
  answers: [{ questionIndex: 0, answer: ASK_QUESTIONS[0]!.options[0]!.label }],
  ...overrides,
});

/** A delegated child's brief: what the model handed it, as the call is written. */
const SUBAGENT_BRIEF = "Read the three layout files and say which one owns the panel's column widths.";

/** What the child came back with: its last message, which is the row's body. */
const SUBAGENT_ANSWER = [
  "The panel's widths live in columns.ts: `memberColumns` measures them and `metricColumns` writes them.",
  "layout.ts only places blocks, so a change there would not move a column.",
].join("\n");

/** A subagent's row: the child it ran, its last message, and what it spent doing it. */
const subagentRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "subagent",
  args: { agent: "scout", task: SUBAGENT_BRIEF },
  status: "success",
  level: 0,
  output: SUBAGENT_ANSWER,
  subagent: { inputTokens: 4400, outputTokens: 41, toolCount: 3, turns: 2, durationMs: 24_000 },
  ...overrides,
});

/** A codemode script: what the model wrote, and the calls it made while it ran. */
const SCRIPT_CODE = [
  "// @options: {}",
  "const ids = ['LOC-348', 'LOC-349', 'LOC-350'];",
  "const res = await Promise.allSettled(ids.map((id) => tools.mcp__linear__get_issue({ id })));",
  "let out = '';",
].join("\n");

const SCRIPT_CALLS: CodemodeCall[] = [
  { name: "mcp__linear__get_issue", args: '{"id":"LOC-346"}', status: "ok", durationMs: 279 },
  { name: "mcp__linear__get_issue", args: '{"id":"LOC-347"}', status: "error", durationMs: 271 },
  { name: "mcp__linear__get_issue", args: '{"id":"LOC-348"}', status: "ok", durationMs: 284 },
];

/** What the script printed, once pi's own header is dropped from it. */
const SCRIPT_OUTPUT = [
  "### LOC-348 [Backlog] - atts:",
  "**Blocked on product:** Robert has not yet confirmed the two items John listed.",
].join("\n");

/** A codemode row: the script's first statement as its title, its calls, then its output. */
const codemodeRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "codemode",
  args: { code: SCRIPT_CODE },
  status: "success",
  level: 0,
  output: `Script completed\nWall time 3.7 seconds\nOutput:\n${SCRIPT_OUTPUT}`,
  codemode: SCRIPT_CALLS,
  durationMs: 3700,
  ...overrides,
});

/** A tool lookup's row: the tools it loaded name its header, its answer is its body. */
const toolSearchRow = (overrides: Partial<ToolRowInput> = {}): ToolRowInput => ({
  name: "tool_search",
  args: { query: "linear create" },
  status: "success",
  level: 0,
  title: "linear/create_issue, linear/list_issues",
  output: 'Loaded 2 tools for "linear create"',
  ...overrides,
});

/** A background run's completion notice: pi-subagents' custom message, in pi-ui's rows. */
const SUBAGENT_NOTICE = {
  content: SUBAGENT_ANSWER,
  details: { runs: [{ agent: "scout", status: "completed" }] },
};

/** The panel's sample list: a finished step, the running one, and what is left. */
const TODO_SAMPLE: TodoItem[] = [
  { id: 1, text: "Commit A: fix — install the image viewer", status: "completed" },
  {
    id: 2,
    text: "Committing the replay harness",
    status: "in_progress",
    activeForm: "Committing the replay harness",
  },
  { id: 3, text: "Commit C: docs gotcha — images never reach a capture", status: "pending" },
  { id: 4, text: "Re-run full gate + e2e, push, report SHAs", status: "pending" },
];

/** The active form says more than the todo's own words. */
const TODO_ACTIVE_FORM: TodoItem[] = [
  { id: 1, text: "Write the panel renderer", status: "in_progress", activeForm: "Writing the panel renderer" },
  { id: 2, text: "Wire it above the editor", status: "pending" },
];

/** Fifteen steps: past the panel's budget, so the completed rows leave first. */
const TODO_MANY: TodoItem[] = [
  ...TODO_SAMPLE,
  ...Array.from(
    { length: 11 },
    (_, index): TodoItem => ({
      id: 5 + index,
      text: `Step ${5 + index}: the rest of the long job`,
      status: "pending",
    }),
  ),
];

/** Every step finished: the panel's one line. */
const TODO_DONE: TodoItem[] = TODO_SAMPLE.map((todo) => ({ ...todo, status: "completed" }));

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

const userMessage = (ctx: RenderCtx, text: string) => {
  const component = new ctx.pi.modules.coding.UserMessageComponent(text, ctx.pi.modules.coding.getMarkdownTheme(), 1);
  restyleUserMessage(component, ctx.theme);
  return component;
};

const oursEntries: EntryDef[] = [
  {
    id: "ours.user",
    title: "User message",
    group: "transcript",
    variant: "ours",
    description: "A submitted prompt on a neutral band, without the padding rows above and below.",
    states: [
      {
        id: "default",
        label: "default",
        render: (ctx) =>
          userMessage(ctx, "Let's make long sessions readable: keep the live detail, fold the rest.").render(ctx.width),
      },
      {
        id: "multiline",
        label: "multiline",
        render: (ctx) =>
          userMessage(ctx, "Review the fold planner.\n\n- keep failures visible\n- one summary per run").render(
            ctx.width,
          ),
      },
    ],
  },
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
      levelState(
        "hashline",
        "hashline anchors",
        0,
        () => readRow({ output: HASHLINE_READ }),
        "pi-hashline-edit numbers every line `12#AB:` so the model can edit by anchor; the gutter numbers the lines already, so a read body drops them",
      ),
      levelState(
        "range",
        "range from offset 95",
        0,
        () =>
          readRow({
            args: { path: readPath, offset: 95, limit: 10 },
            output: `${FILE_TEXT}\n\n[121 more lines in file. Use offset=105 to continue.]`,
          }),
        "line numbers start at the offset and align to the widest one shown; pi's note on the rest of the file is the last notice",
      ),
      levelState("error", "error", 0, () =>
        readRow({ status: "error", error: "ENOENT: no such file", output: "", summary: "" }),
      ),
      levelState(
        "opened-path",
        "opened, long path",
        0,
        () =>
          readRow({
            args: { path: LONG_READ_PATH },
            title: LONG_READ_PATH,
            output: FILE_TEXT.split("\n").slice(0, 3).join("\n"),
            expanded: true,
            full: true,
          }),
        "an opened block never cuts its title: the path breaks after a `/` and continues under its start",
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
      levelState(
        "long",
        "long log, aged L4",
        4,
        () =>
          bashRow({
            args: { command: "git log -5 --oneline; git branch -vv; ls" },
            title: undefined,
            output: SHELL_LONG,
          }),
        "the newest lines stay; the notice above them counts the lines hidden above",
      ),
      levelState(
        "writing",
        "being written",
        0,
        () =>
          bashRow({
            status: "pending",
            args: { command: WRITTEN_SCRIPT },
            title: undefined,
            output: "",
            durationMs: undefined,
          }),
        "a command its header cannot show whole streams under it, newest lines last, until its output starts",
      ),
      levelState(
        "rg",
        "rg across files",
        0,
        () =>
          bashRow({
            args: { command: "rg -n -A1 'toolRowLayout\\(|renderToolRow\\(' extensions render/index.ts" },
            title: undefined,
            output: SHELL_GREP,
          }),
        "grep's line numbers move into the gutter and each file's lines take its syntax colours; a path row heads each file and ⋮ marks the lines grep skipped",
      ),
      levelState(
        "file",
        "numbered file range",
        0,
        () =>
          bashRow({
            args: { command: "cat -n packages/pi-ui/render/detail.ts | sed -n '48,51p'" },
            title: undefined,
            output: SHELL_NUMBERED,
          }),
        "cat -n and nl print their own numbers: they move into the gutter, and the code takes the file's syntax colours",
      ),
      levelState("error", "failed", 0, () =>
        bashRow({ status: "error", output: SHELL_OUTPUT, summary: "", error: "exit 2" }),
      ),
      levelState(
        "opened",
        "opened, long command",
        0,
        () =>
          bashRow({
            args: { command: OPENED_COMMAND },
            title: undefined,
            expanded: true,
            full: true,
          }),
        "the header keeps the command's first segment; the rest lines up under it",
      ),
      levelState(
        "changes",
        "changed two files",
        0,
        () => changedFilesRow(),
        "files the command created or changed in its git work tree follow the output: a path row, then the diff read like an edit's",
      ),
      levelState(
        "changes-l4",
        "changed two files, aged L4",
        4,
        () => changedFilesRow(),
        "the diffs share the row budget with the output: an older block keeps fewer of their lines",
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
      {
        id: "writing",
        label: "being written",
        note: "the replacement streams as the model writes it: old text as removed lines, then new text as added ones",
        frames: 10,
        render: (ctx, frame) =>
          renderToolRow(
            ours(ctx),
            editRow({
              status: "pending",
              output: "",
              summary: "",
              durationMs: undefined,
              args: { path: editPath, edits: [writtenEdit(Math.round(((frame + 1) / 10) * WRITTEN_TOTAL))] },
            }),
          ).render(ctx.width),
      },
      levelState("l0", "success L0", 0, () => editRow()),
      levelState("l1", "aged L1", 1, () => editRow()),
      levelState("l3", "aged L3", 3, () => editRow()),
      levelState(
        "hashline",
        "hashline diff",
        0,
        () => editRow({ output: HASHLINE_DIFF, summary: "+2 −1" }),
        "pi-hashline-edit anchors the lines its diff keeps and numbers the removed ones; the anchors never reach the row",
      ),
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
    states: [
      levelState(
        "writing",
        "being written",
        0,
        () =>
          mcpRow({
            status: "pending",
            output: "",
            summary: "",
            durationMs: undefined,
            title: undefined,
            args: { query: "recency grading", limit: 5, scope: { project: "pi-ui", kinds: ["decision", "risk"] } },
          }),
        "the arguments the title does not show stream as fields until the result arrives",
      ),
      levelState("l0", "success L0", 0, () => mcpRow()),
      levelState("l3", "aged L3", 3, () => mcpRow()),
    ],
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
  {
    id: "ours.todos",
    title: "Todos panel",
    group: "todos",
    variant: "ours",
    description:
      "The session's todo list above the editor: a count, its bar, and ids that match the transcript. Over the panel's budget the work keeps its rows and the finished ones are counted into one notice.",
    states: [
      {
        id: "live",
        label: "live",
        note: "one done, one running, two pending",
        frames: 10,
        render: (ctx, frame) => renderTodosPanel(ours(ctx), () => ({ todos: TODO_SAMPLE, frame })).render(ctx.width),
      },
      {
        id: "active-form",
        label: "active form says more",
        render: (ctx) => renderTodosPanel(ours(ctx), () => ({ todos: TODO_ACTIVE_FORM, frame: 0 })).render(ctx.width),
      },
      {
        id: "over-budget",
        label: "fifteen steps",
        note: "the heading and notice stay inside the ten lines",
        render: (ctx) => renderTodosPanel(ours(ctx), () => ({ todos: TODO_MANY, frame: 0 })).render(ctx.width),
      },
      {
        id: "done",
        label: "all done",
        note: "one line",
        render: (ctx) => renderTodosPanel(ours(ctx), () => ({ todos: TODO_DONE, frame: 0 })).render(ctx.width),
      },
      {
        id: "narrow",
        label: "narrow",
        render: (ctx) => renderTodosPanel(ours(ctx), () => ({ todos: TODO_SAMPLE, frame: 0 })).render(36),
      },
    ],
  },
  {
    id: "ours.todo",
    title: "todo row",
    group: "tools",
    variant: "ours",
    description:
      "A todo call's row: what it does to which row, with the list's confirmation under it; aged rows keep the header alone.",
    states: [
      levelState("l0", "start L0", 0, () => todoRow()),
      levelState("aged", "aged L3", 3, () => todoRow()),
      levelState("add", "add", 0, () =>
        todoRow({ args: { action: "add" }, title: "add", output: "Added todo #5: Render the panel" }),
      ),
      levelState("failed", "not found", 0, () =>
        todoRow({
          status: "error",
          args: { action: "complete", id: 9 },
          title: "complete #9",
          output: "",
          error: "#9 not found",
        }),
      ),
    ],
  },
  {
    id: "ours.ask",
    title: "ask row",
    group: "tools",
    variant: "ours",
    description:
      "A question prompt's row in pi-ui's vocabulary: the question as the title, the answer checked under it, and, opened or unanswered, the options with their trade-offs.",
    states: [
      levelState("l0", "answered L0", 0, () => askRow()),
      levelState("aged", "aged L3", 3, () => askRow()),
      levelState("pending", "unanswered", 0, () => askRow({ status: "pending", output: "", answers: undefined })),
      levelState("multi", "two questions", 0, () =>
        askRow({
          args: { questions: ASK_PAIR },
          answers: [
            { questionIndex: 0, answer: ASK_QUESTIONS[0]!.options[0]!.label },
            { questionIndex: 1, answer: "One commit per module" },
          ],
        }),
      ),
      levelState(
        "opened",
        "opened, the options",
        0,
        () => askRow({ expanded: true, full: true }),
        "every option it offered, the chosen one checked and each trade-off under its label",
      ),
      levelState("cancelled", "cancelled", 0, () =>
        askRow({
          output: "User cancelled the questions before answering.",
          answers: [],
          cancelled: true,
        }),
      ),
    ],
  },
  {
    id: "ours.subagent",
    title: "subagent row",
    group: "tools",
    variant: "ours",
    description:
      "A delegated child's row: the brief it was handed while the call is written, its last message when it lands, and what it spent under it.",
    states: [
      levelState("l0", "done L0", 0, () => subagentRow()),
      levelState("aged", "aged L3", 3, () => subagentRow()),
      levelState("brief", "brief streaming", 0, () =>
        subagentRow({ status: "pending", output: "", subagent: undefined }),
      ),
      levelState(
        "async",
        "background run",
        0,
        () =>
          subagentRow({
            output: "",
            subagent: { asyncId: "49de7dd6-380e-4b11-98c5-b2c1cdd37a8c" },
          }),
        "the call returned while the child kept going",
      ),
      levelState("rejected", "acceptance rejected", 0, () =>
        subagentRow({
          output: "Renamed the module; two imports still point at the old name.",
          subagent: { inputTokens: 8200, outputTokens: 96, toolCount: 5, turns: 3, rejected: true },
        }),
      ),
      {
        id: "notice",
        label: "completion notice",
        render: (ctx) => noticeLines(ctx.kit, ctx.theme, SUBAGENT_NOTICE, ctx.width, true),
      },
    ],
  },
  {
    id: "ours.codemode",
    title: "codemode row",
    group: "tools",
    variant: "ours",
    description:
      "A script's row: its first statement names it, the calls it made lead its output, and opening it shows every call.",
    states: [
      levelState("l0", "done L0", 0, () => codemodeRow()),
      levelState("aged", "aged L3", 3, () => codemodeRow()),
      levelState(
        "streaming",
        "script streaming",
        0,
        () =>
          codemodeRow({
            status: "pending",
            output: "",
            codemode: undefined,
            args: { code: SCRIPT_CODE.split("\n").slice(0, 3).join("\n") },
          }),
        "the script as the model writes it",
      ),
      levelState(
        "running",
        "script running",
        0,
        () => codemodeRow({ status: "running", output: "", codemode: SCRIPT_CALLS.slice(0, 2) }),
        "its calls while they run",
      ),
      levelState("folded", "calls folded", 0, () =>
        codemodeRow({
          output: "Script completed\nWall time 6.1 seconds\nOutput:\n### LOC-348 [Backlog]\nBlocked.",
          codemode: Array.from({ length: 9 }, (_, index) => ({
            name: "mcp__linear__get_issue",
            args: `{"id":"LOC-${index}"}`,
            status: index === 8 ? "error" : "ok",
            durationMs: 280,
          })) satisfies CodemodeCall[],
        }),
      ),
      levelState("opened", "opened L0", 0, () => codemodeRow({ expanded: true, full: true })),
      levelState("failed", "script failed", 0, () =>
        codemodeRow({
          status: "error",
          output: "Script error:\nReferenceError: ids is not defined",
          codemode: SCRIPT_CALLS.slice(0, 1),
        }),
      ),
    ],
  },
  {
    id: "ours.tool_search",
    title: "tool_search row",
    group: "tools",
    variant: "ours",
    description:
      "A tool lookup: the tools it loaded name its header, and its answer names the words it searched for. A lookup that found nothing keeps its label.",
    states: [
      levelState("l0", "loaded L0", 0, () => toolSearchRow()),
      levelState("aged", "aged L3", 3, () => toolSearchRow()),
      levelState(
        "none",
        "nothing found",
        0,
        () => toolSearchRow({ title: "", output: "No matching tools found." }),
        "its header falls back to its label",
      ),
      levelState("streaming", "lookup written", 0, () =>
        toolSearchRow({ status: "pending", output: "", title: undefined }),
      ),
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
  { ...editRow({ title: "extensions/pi-ui/decorator.ts", summary: "+42 −7" }), key: "edit-1" },
  {
    ...readRow({ title: "src/modes/interactive/components/assistant-message.js" }),
    key: "read-3",
  },
  { ...editRow({ title: "extensions/pi-ui/thinking.ts", summary: "+18 −3" }), key: "edit-2" },
  { ...bashRow({ title: "bun run typecheck", output: SHELL_OK, durationMs: 2400 }), key: "bash-3" },
  { ...readRow({ title: "extensions/pi-ui/fold.ts" }), key: "read-4" },
  { ...editRow({ title: "extensions/pi-ui/fold.ts", summary: "+9 −2" }), key: "edit-3" },
  { ...readRow({ title: "extensions/pi-ui/fold.test.ts" }), key: "read-5" },
  { ...editRow({ title: "extensions/pi-ui/fold.test.ts", summary: "+24 −0" }), key: "edit-4" },
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

  const thought = (
    block: Extract<ScenarioBlock, { kind: "thinking" }>,
    level: DetailLevel,
    width: number,
    columns?: MemberColumns,
    columnLabels?: ColumnLabels,
  ) =>
    thinkingLabel(api, {
      phase: "aged",
      level,
      text: block.text,
      width,
      durationMs: block.durationMs,
      columns,
      ...(columnLabels === undefined ? {} : { columnLabels }),
    }).split("\n");
  // An open group lines its members up in columns, from every member's cells.
  const cellsOf = (block: ScenarioBlock): MemberCells[] =>
    block.kind === "tool"
      ? [toolRowCells(block.row)]
      : block.kind === "thinking"
        ? [thoughtCells({ phase: "aged", text: block.text, durationMs: block.durationMs })]
        : [];
  // Each column's word sits on the first member row that fills it; the rows under it carry only numbers, as live.
  const member = (block: ScenarioBlock, width: number, columns: MemberColumns, columnLabels: ColumnLabels): string[] =>
    renderGroupMember(
      ctx.kit,
      width,
      (inner) =>
        block.kind === "tool"
          ? [toolHeader(api, { ...block.row, level: COMPACT_LEVEL, columns, columnLabels }, inner).line]
          : block.kind === "thinking"
            ? thought(block, COMPACT_LEVEL, inner, columns, columnLabels)
            : [],
      cutMark(api.theme),
    );

  const components: Rendered[] = [];
  for (const block of blocks) {
    if (block.kind === "user") {
      components.push(userMessage(ctx, block.text));
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
      const columns = memberColumns(members.flatMap(cellsOf), ctx.kit.visibleWidth);
      const labels = columnLabelRows(members.map((item) => cellsOf(item)[0] ?? { label: "" }));
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
          ...(group.open ? members.flatMap((item, index) => member(item, width, columns, labels[index]!)) : []),
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
    description: `Nine ages, one newer block apart: a preview keeps one line fewer every ${BLOCKS_PER_STEP} newer blocks, then folds into a group.`,
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
        note: `${FOLD_DISTANCE} blocks later: the new run's first group lists its members until it holds six rows.`,
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
    note: "Six frames of ░▒▓█: reads as pressure building, not rotation.",
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
      "Four candidates for the block icon: shape-coded by taxonomy, status rings, nerd font, or today's single marker.",
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
    description: "All single-cell animations side by side, each cycling at its own length.",
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
