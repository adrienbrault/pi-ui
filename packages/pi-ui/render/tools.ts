/** Tool taxonomy: which class a tool belongs to, how it trends, how it reads. */

import { UNICODE_GLYPHS, type TokenMarks } from "./glyphs.ts";
import { formatDuration } from "./text.ts";

export type ToolClass =
  | "read"
  | "list"
  | "search"
  | "write"
  | "edit"
  | "shell"
  | "web"
  | "todo"
  | "ask"
  | "subagent"
  | "mcp"
  | "code"
  | "toolbox"
  | "generic";

export type Trend = "head" | "tail";

export interface ToolMeta {
  cls: ToolClass;
  label: string;
  trend: Trend;
}

const META: Record<string, ToolMeta> = {
  read: { cls: "read", label: "read", trend: "head" },
  ls: { cls: "list", label: "ls", trend: "head" },
  grep: { cls: "search", label: "grep", trend: "head" },
  find: { cls: "search", label: "find", trend: "head" },
  ffgrep: { cls: "search", label: "grep", trend: "head" },
  fffind: { cls: "search", label: "find", trend: "head" },
  multi_grep: { cls: "search", label: "grep", trend: "head" },
  write: { cls: "write", label: "write", trend: "head" },
  edit: { cls: "edit", label: "edit", trend: "head" },
  bash: { cls: "shell", label: "bash", trend: "tail" },
  powershell: { cls: "shell", label: "powershell", trend: "tail" },
  web_fetch: { cls: "web", label: "fetch", trend: "head" },
  web_search: { cls: "web", label: "search", trend: "head" },
  fetch_content: { cls: "web", label: "fetch", trend: "head" },
  codemode: { cls: "code", label: "codemode", trend: "tail" },
  tool_search: { cls: "toolbox", label: "tool_search", trend: "head" },
  todo: { cls: "todo", label: "todo", trend: "head" },
  ask_user_question: { cls: "ask", label: "ask", trend: "head" },
  subagent: { cls: "subagent", label: "subagent", trend: "head" },
};

/** `mcp__server__tool` -> `server/tool`. */
export function mcpLabel(name: string): string {
  const rest = name.replace(/^mcp__/, "");
  const split = rest.indexOf("__");
  return split === -1 ? rest : `${rest.slice(0, split)}/${rest.slice(split + 2)}`;
}

export function toolMeta(name: string): ToolMeta {
  const known = META[name];
  if (known) return known;
  if (name.startsWith("mcp__")) return { cls: "mcp", label: mcpLabel(name), trend: "head" };
  return { cls: "generic", label: name, trend: "head" };
}

/**
/** Whether pi-ui renders this tool's rows: every tool the taxonomy names, and MCP's. A tool
 * the taxonomy does not name keeps its own renderer. */
export function ownsTool(name: string): boolean {
  if (name.startsWith("mcp__")) return true;
  return Object.hasOwn(META, name);
}

/** One option of a question: the label a user picks, and the trade-off the model wrote under it. */
export interface AskedOption {
  label: string;
  description?: string;
}

/** One question of an `ask_user_question` call, as the model wrote it. */
export interface AskedQuestion {
  question: string;
  /** A short name for the question, shown where a title has no room for it. */
  header?: string;
  options: AskedOption[];
  multiSelect?: boolean;
}

/** An answer the tool came back with, from its result's `details.answers`. */
export interface AskedAnswer {
  questionIndex: number;
  answer: string;
}

/** Every question a call asks, as the model wrote it; anything else is ignored. */
export function askedQuestions(args: Record<string, unknown> = {}): AskedQuestion[] {
  const raw = args.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): AskedQuestion[] => {
    if (!entry || typeof entry !== "object") return [];
    const question = entry as Record<string, unknown>;
    if (typeof question.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): AskedOption[] => {
          if (!option || typeof option !== "object") return [];
          const label = (option as { label?: unknown }).label;
          if (typeof label !== "string") return [];
          const description = (option as { description?: unknown }).description;
          return [{ label, ...(typeof description === "string" ? { description } : {}) }];
        })
      : [];
    return [
      {
        question: question.question.replace(/\s+/g, " ").trim(),
        ...(typeof question.header === "string" ? { header: question.header } : {}),
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      },
    ];
  });
}

/**
 * The answers a result's `details` carry, and whether the user cancelled. Undefined when the
 * details are not a question prompt's: no tool needs to say which one it is.
 */
export function askedAnswers(details: unknown): { answers: AskedAnswer[]; cancelled: boolean } | undefined {
  if (!details || typeof details !== "object") return undefined;
  const held = details as { answers?: unknown; cancelled?: unknown };
  if (!Array.isArray(held.answers)) return undefined;
  const answers = held.answers.flatMap((entry): AskedAnswer[] => {
    if (!entry || typeof entry !== "object") return [];
    const answer = entry as { answer?: unknown; questionIndex?: unknown };
    if (typeof answer.answer !== "string") return [];
    const questionIndex = typeof answer.questionIndex === "number" ? answer.questionIndex : 0;
    return [{ questionIndex, answer: answer.answer }];
  });
  return { answers, cancelled: held.cancelled === true };
}

/** One child's run, as a `subagent` result's `details` reported it. */
export interface SubagentRun {
  /** The child the details name. */
  agent?: string;
  /** `single`, `workflow`, `management`, …: only a run has one worth reading. */
  mode?: string;
  /** The child's last message: what it came back with. */
  output?: string;
  toolCount?: number;
  turns?: number;
  /** The child's own tokens: what it sent and what it returned, not the call's arguments. */
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** The child's exit code, when it did not finish cleanly. */
  exitCode?: number;
  stopped?: boolean;
  /** The run's acceptance check did not pass its criteria. */
  rejected?: boolean;
  /** A background run's id: the call returned while the child kept going. */
  asyncId?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/**
 * The run a `subagent` result's `details` describe, or undefined when they describe something
 * else: a management action (`action: "models"`) answers with text and has no run behind it.
 */
export function subagentRun(details: unknown): SubagentRun | undefined {
  if (!details || typeof details !== "object") return undefined;
  const held = details as Record<string, unknown>;
  const asyncId = typeof held.asyncId === "string" ? held.asyncId : undefined;
  const runs = Array.isArray(held.results) ? held.results : [];
  const first = runs[0] === undefined ? undefined : asRecord(runs[0]);
  if (!first && !asyncId) return undefined;
  const usage = asRecord(first?.usage);
  const progress = asRecord(first?.progressSummary ?? first?.progress);
  const accepted = asRecord(first?.acceptance);
  const input = asNumber(usage.input);
  const output = asNumber(usage.output);
  const final = typeof first?.finalOutput === "string" ? first.finalOutput.trim() : undefined;
  return {
    agent: typeof first?.agent === "string" ? first.agent : undefined,
    mode: typeof held.mode === "string" ? held.mode : undefined,
    ...(final ? { output: final } : {}),
    toolCount: asNumber(progress.toolCount),
    turns: asNumber(usage.turns),
    inputTokens: input,
    outputTokens: output,
    durationMs: asNumber(progress.durationMs),
    exitCode: asNumber(first?.exitCode),
    ...(first?.stopped === true ? { stopped: true } : {}),
    ...(accepted.status === "rejected" ? { rejected: true } : {}),
    asyncId,
  };
}

/** One tool call a `codemode` script made, as the script's `details.calls` report it. */
export interface CodemodeCall {
  /** The tool the script called, as pi names it: `bash`, `mcp__linear__get_issue`, `models.classify`. */
  name: string;
  /** pi's preview of the arguments: one line, already cut. */
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  /** What a model call cost, when the script asked a model to do something. */
  cost?: number;
  error?: string;
}

const CALL_STATUSES = new Set(["running", "ok", "error", "cancelled"]);

/**
 * The calls a `codemode` result's `details` list, in the order the script made them: the script's
 * own tool calls, which never reach the model as tool calls, and its model calls.
 */
export function codemodeCalls(details: unknown): CodemodeCall[] | undefined {
  const held = asRecord(details);
  if (!Array.isArray(held.calls)) return undefined;
  const calls = held.calls.flatMap((entry): CodemodeCall[] => {
    const call = asRecord(entry);
    const name = typeof call.name === "string" ? call.name : "";
    if (!name) return [];
    const status = typeof call.status === "string" && CALL_STATUSES.has(call.status) ? call.status : "running";
    return [
      {
        name,
        args: typeof call.args === "string" ? call.args : "",
        status: status as CodemodeCall["status"],
        ...(asNumber(call.durationMs) === undefined ? {} : { durationMs: asNumber(call.durationMs) }),
        ...(asNumber(call.cost) === undefined ? {} : { cost: asNumber(call.cost) }),
        ...(typeof call.error === "string" ? { error: call.error } : {}),
      },
    ];
  });
  return calls.length ? calls : undefined;
}

/** What a script's model calls cost together, when it made more than one: a single price is the call's own. */
export function codemodeCost(calls: readonly CodemodeCall[]): number | undefined {
  const priced = calls.filter((call) => call.cost);
  return priced.length > 1 ? priced.reduce((sum, call) => sum + (call.cost ?? 0), 0) : undefined;
}

const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

/** A script's output without the header pi writes around it, which its run already says. */
export function scriptOutput(text: string): string {
  return text.replace(SCRIPT_HEADER, "");
}

/** The tools a `tool_search` result loaded, as its details name them: what its header shows. */
export function loadedTools(details: unknown): string[] | undefined {
  const names = asRecord(details).loaded;
  if (!Array.isArray(names)) return undefined;
  const tools = names.filter((name): name is string => typeof name === "string" && !!name.trim());
  return tools.length ? tools : undefined;
}

/** A script's first statement: the first line that is neither blank nor a comment. */
export function firstCodeLine(code: string): string {
  const line = code
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("//"));
  return (line ?? "").replace(/\s+/g, " ").trim();
}

/** Keys that identify a call when we know nothing else about the tool. */
const DETAIL_KEYS = ["command", "query", "sql", "pattern", "prompt", "task", "url", "path", "file_path"];

/** Keys whose value is a file or directory path. */
const PATH_KEYS = new Set(["path", "file_path"]);

/** Where the session runs: titles read paths and commands relative to it. */
export interface SessionPlace {
  /** The session's working directory, absolute. */
  cwd?: string;
  /** The user's home directory, to read `~/…` paths. */
  home?: string;
}

/** A path as the session sees it: relative when it is inside the working directory, as written otherwise. */
export function sessionPath(path: string, place: SessionPlace = {}): string {
  const cwd = place.cwd?.replace(/\/+$/, "");
  if (!cwd) return path;
  const expanded =
    place.home && (path === "~" || path.startsWith("~/")) ? place.home.replace(/\/+$/, "") + path.slice(1) : path;
  const absolute = expanded.replace(/\/+$/, "") || "/";
  if (absolute === cwd) return ".";
  return absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : path;
}

/**
 * A shell command without a leading `cd` into the working directory: the
 * command runs there anyway, and the prefix would take the header's room.
 */
export function sessionCommand(command: string, place: SessionPlace = {}): string {
  const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)\s*/.exec(command);
  if (!match) return command;
  const dir = match[1] ?? match[2] ?? match[3] ?? "";
  return sessionPath(dir, place) === "." && match[0].length < command.length ? command.slice(match[0].length) : command;
}

/** The argument a call's one-line title shows: the first of the detail keys that holds text. */
export function titleKey(name: string, args: Record<string, unknown> = {}): string | undefined {
  const keys = toolMeta(name).cls === "shell" ? ["command"] : DETAIL_KEYS;
  return keys.find((key) => {
    const value = args[key];
    return typeof value === "string" && !!value.trim();
  });
}

export function describeCall(
  name: string,
  args: Record<string, unknown> = {},
  place: SessionPlace = {},
): { title: string; meta: ToolMeta } {
  const meta = toolMeta(name);
  // A codemode script's title reads its first statement: its options line and its comments say
  // nothing about what the script does.
  if (meta.cls === "code") {
    const code = typeof args.code === "string" ? args.code : "";
    return { title: firstCodeLine(code), meta };
  }
  // An ask's title names the question: its header, the question itself, or how many there are.
  if (meta.cls === "ask") {
    const questions = askedQuestions(args);
    const first = questions[0];
    const title = questions.length > 1 ? `${questions.length} questions` : ((first?.header || first?.question) ?? "");
    return { title, meta };
  }
  // A subagent call's title names the child it runs, or the workflow, or the management action.
  if (meta.cls === "subagent") {
    const agent = typeof args.agent === "string" ? args.agent.trim() : "";
    const action = typeof args.action === "string" ? args.action.trim() : "";
    const workflow = args.workflow;
    const title = action
      ? [action, agent].filter(Boolean).join(" ")
      : workflow === undefined || workflow === false
        ? agent
        : workflow === true || workflow === "true"
          ? "workflow (reply block)"
          : `workflow ${String(workflow)}`;
    return { title, meta };
  }
  // A todo call's title is what it does to which row: `start #2`.
  if (meta.cls === "todo") {
    const action = typeof args.action === "string" ? args.action : "";
    const id = typeof args.id === "number" ? `#${args.id}` : "";
    return { title: [action, id].filter(Boolean).join(" "), meta };
  }
  const key = titleKey(name, args);
  if (key !== undefined) {
    const value = args[key];
    if (typeof value === "string") {
      const placed =
        meta.cls === "shell"
          ? sessionCommand(value, place)
          : PATH_KEYS.has(key)
            ? sessionPath(value.trim(), place)
            : value;
      return { title: placed.replace(/\s+/g, " ").trim(), meta };
    }
  }
  return { title: "", meta };
}

/** pi's context estimator budgets one token per four UTF-16 code units. */
export function estimatedTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function callTokens(name: string, args: Record<string, unknown>): number {
  return estimatedTokens(name.length + JSON.stringify(args).length);
}

export interface TokenCounts {
  outputTokens: number;
  inputTokens: number;
}

export function toolTokenCounts(input: {
  name: string;
  args?: Record<string, unknown>;
  output?: string;
  outputTokens?: number;
  inputTokens?: number;
}): TokenCounts {
  return {
    outputTokens: input.outputTokens ?? callTokens(input.name, input.args ?? {}),
    inputTokens: input.inputTokens ?? estimatedTokens(input.output?.length ?? 0),
  };
}

export function sumTokens(counts: TokenCounts[]): TokenCounts {
  return counts.reduce(
    (sum, row) => ({
      outputTokens: sum.outputTokens + row.outputTokens,
      inputTokens: sum.inputTokens + row.inputTokens,
    }),
    { outputTokens: 0, inputTokens: 0 },
  );
}

export interface TokenRates {
  inputRate?: number;
  inputRateEstimated?: boolean;
  outputRate?: number;
}

/**
 * Columns every row leaves empty at its right edge. pi draws its scroll bar
 * over the last column while the transcript is scrolled: a right-aligned
 * duration would lose its unit (`28ms` reads `28m`), and a wrapped body row
 * its last letter.
 */
export const HEADER_MARGIN = 1;

/**
 * Output tokens a rate needs before a header shows it. A handful of tokens
 * arrives in one burst, and their rate (`5 tokens at 985/s`) measures the
 * burst, not the model.
 */
export const MIN_RATE_TOKENS = 20;

/** The output rate a header shows for this many tokens: none from a sample too small to measure. */
export function outputRateFor(tokens: number, rate: number | null | undefined): number | undefined {
  return rate && tokens >= MIN_RATE_TOKENS ? rate : undefined;
}

export function formatRate(value: number): string {
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return value < 10 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

/** `~` marks a client-side estimate so it never reads as a measured rate. */
function rateSuffix(rate?: number, estimated = false): string {
  return rate ? ` @ ${estimated ? "~" : ""}${formatRate(rate)}/s` : "";
}

/**
 * Every header's token numbers, one format: `↑2.6k · ↓9 @ 48/s`, input (sent) then output
 * (returned) as pi's footer marks them, counts abbreviated past a thousand. Input comes first:
 * output always has a count, so it keeps the right-hand edge. No input yet (a running call,
 * a group of thoughts) leaves `↑` out rather than writing `↑0`.
 */
export function toolTokenLabel(
  outputTokens: number,
  inputTokens: number,
  rates?: TokenRates,
  marks: TokenMarks = UNICODE_GLYPHS,
): string {
  const output = `${marks.output}${formatRate(outputTokens)}${rateSuffix(outputRateFor(outputTokens, rates?.outputRate))}`;
  if (!inputTokens && !rates?.inputRate) return output;
  return `${marks.input}${formatRate(inputTokens)}${rateSuffix(rates?.inputRate, rates?.inputRateEstimated)} ${marks.dot} ${output}`;
}

/** Thinking folds with tool rows; its verb belongs to the same vocabulary. */
export type GroupClass = ToolClass | "thinking";

/** Group vocabulary: what one collapsed row of this class is called. */
export function groupNoun(cls: GroupClass): string {
  switch (cls) {
    case "read":
    case "write":
    case "edit":
      return "file";
    case "list":
      return "directory";
    case "search":
      return "pattern";
    case "shell":
      return "shell command";
    case "web":
      return "URL";
    case "mcp":
      return "MCP tool";
    case "code":
      return "script";
    case "toolbox":
      return "tool";
    case "generic":
      return "tool";
    case "todo":
      return "todo";
    case "ask":
      return "question";
    case "subagent":
      return "subagent";
    case "thinking":
      return "thought";
  }
}

function pluralNoun(cls: GroupClass, count: number): string {
  const noun = groupNoun(cls);
  if (count === 1) return noun;
  return noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

/**
 * One segment of a group summary, lower case, to be joined into a sentence:
 * `thought for 3m 40s`, `listed 3 directories`, `ran 30 shell commands for 2m 05s`.
 * Thinking reads as time and shell commands carry their runtime when every
 * member was timed (`durationMs`); otherwise thinking falls back to a count.
 */
export function groupVerb(cls: GroupClass, count: number, durationMs?: number): string {
  const things = `${count} ${pluralNoun(cls, count)}`;
  const time = durationMs === undefined ? "" : ` for ${formatDuration(durationMs)}`;
  switch (cls) {
    case "read":
      return `read ${things}`;
    case "list":
      return `listed ${things}`;
    case "search":
      return `searched for ${things}`;
    case "write":
      return `wrote ${things}`;
    case "edit":
      return `edited ${things}`;
    case "shell":
      return `ran ${things}${time}`;
    case "web":
      return `fetched ${things}`;
    case "mcp":
    case "generic":
      return `called ${things}`;
    case "todo":
      return `updated ${things}`;
    case "ask":
      return `asked ${things}`;
    case "subagent":
      return `ran ${things}`;
    case "code":
      return `ran ${things}`;
    case "toolbox":
      return `looked up ${things}`;
    case "thinking":
      return durationMs === undefined ? `thought ${count} time${count === 1 ? "" : "s"}` : `thought${time}`;
  }
}
