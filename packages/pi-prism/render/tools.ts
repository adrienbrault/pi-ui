/** Tool taxonomy: which class a tool belongs to, how it trends, how it reads. */

export type ToolClass = "read" | "search" | "write" | "edit" | "shell" | "web" | "mcp" | "code" | "generic";

export type Trend = "head" | "tail";

export interface ToolMeta {
  cls: ToolClass;
  label: string;
  trend: Trend;
}

const META: Record<string, ToolMeta> = {
  read: { cls: "read", label: "read", trend: "head" },
  ls: { cls: "read", label: "ls", trend: "head" },
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

/** A short, truthful count for a collapsed row. */
export function summarizeOutput(output: string): string {
  const lines = output.split("\n").filter((line) => line.trim()).length;
  if (lines === 0) return "";
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Group vocabulary: what N collapsed rows of this class become. */
export function groupNoun(cls: ToolClass): string {
  switch (cls) {
    case "read":
      return "file";
    case "search":
      return "search";
    case "write":
      return "file";
    case "edit":
      return "file";
    case "shell":
      return "command";
    case "web":
      return "URL";
    case "mcp":
      return "MCP tool";
    case "code":
      return "script";
    case "generic":
      return "tool";
  }
}

export function groupVerb(cls: ToolClass, count: number): string {
  const noun = groupNoun(cls);
  const pluralNoun = count === 1 ? noun : `${noun}s`;
  switch (cls) {
    case "read":
      return `Read ${count} ${pluralNoun}`;
    case "search":
      return `Searched ${count} time${count === 1 ? "" : "s"}`;
    case "write":
      return `Wrote ${count} ${pluralNoun}`;
    case "edit":
      return `Edited ${count} ${pluralNoun}`;
    case "shell":
      return `Ran ${count} ${pluralNoun}`;
    case "web":
      return `Fetched ${count} ${pluralNoun}`;
    case "mcp":
      return `Called ${count} ${pluralNoun}`;
    case "code":
      return `Ran ${count} ${pluralNoun}`;
    case "generic":
      return `Called ${count} ${pluralNoun}`;
  }
}
