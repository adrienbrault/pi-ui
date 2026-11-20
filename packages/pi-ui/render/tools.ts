/** Tool taxonomy: which class a tool belongs to, how it trends, how it reads. */

import { formatDuration } from "./text.ts";

export type ToolClass = "read" | "list" | "search" | "write" | "edit" | "shell" | "web" | "mcp" | "code" | "generic";

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
  tool_search: { cls: "code", label: "tool_search", trend: "head" },
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
 * Whether pi-ui renders this tool's rows. Every classified tool and every MCP
 * tool is owned, so it can fold with its peers. The `code` class is not: its
 * nested-call rollup does not exist yet, so those tools keep their own renderer.
 * Unknown tools (pi-code's todo, subagent, …) are always left alone.
 */
export function ownsTool(name: string): boolean {
  if (name.startsWith("mcp__")) return true;
  return Object.hasOwn(META, name) && META[name]!.cls !== "code";
}

/** Keys that identify a call when we know nothing else about the tool. */
const DETAIL_KEYS = ["command", "query", "sql", "pattern", "prompt", "task", "url", "path", "file_path"];

export function describeCall(name: string, args: Record<string, unknown> = {}): { title: string; meta: ToolMeta } {
  const meta = toolMeta(name);
  const keys = meta.cls === "shell" ? ["command"] : DETAIL_KEYS;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return { title: value.replace(/\s+/g, " ").trim(), meta };
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

export function formatRate(value: number): string {
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return value < 10 ? String(Number(value.toFixed(1))) : String(Math.round(value));
}

/** `~` marks a client-side estimate so it never reads as a measured rate. */
function rateSuffix(rate?: number, estimated = false): string {
  return rate ? ` @ ${estimated ? "~" : ""}${formatRate(rate)}/s` : "";
}

export function toolTokenLabel(outputTokens: number, inputTokens: number, rates?: TokenRates): string {
  if (!rates?.outputRate && !rates?.inputRate) return `${outputTokens} out / ${inputTokens} in tokens`;
  return `out ${formatRate(outputTokens)}${rateSuffix(rates.outputRate)} · in ${formatRate(inputTokens)}${rateSuffix(rates.inputRate, rates.inputRateEstimated)}`;
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
    case "generic":
      return "tool";
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
    case "code":
      return `ran ${things}`;
    case "thinking":
      return durationMs === undefined ? `thought ${count} time${count === 1 ? "" : "s"}` : `thought${time}`;
  }
}
