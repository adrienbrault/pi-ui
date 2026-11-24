/**
 * What a tool call shows of its arguments while the model is still writing them, so every token
 * it generates is on screen as it arrives, not only counted:
 *
 * - an edit: its replacements as they are written, each `oldText` as removed lines, then its
 *   `newText` as added lines;
 * - a shell command too long or too tall for its header: the whole command;
 * - a subagent: the brief it was handed, as the model writes it;
 * - any other call: every argument its one-line title does not show, one field after another.
 *
 * Pure: it reads the partial arguments pi passes and returns plain text. Arguments arrive
 * half-written (a string cut mid-word, the last edit without its `newText`), and pi's edit tool
 * accepts several shapes; anything this module does not recognise falls back to the fields.
 */

import { titleKey, toolMeta } from "./tools.ts";

/** One replacement as far as the model has written it. */
export interface StreamedEdit {
  oldText?: string;
  newText?: string;
}

export type CallView =
  | { kind: "edit"; path?: string; edits: StreamedEdit[] }
  /** One argument's text as written, with no field name: a brief, not a command. */
  | { kind: "text"; text: string }
  | { kind: "command"; command: string }
  | { kind: "fields"; fields: Array<{ key: string; value: string }> };

/** One of pi's replacements: `oldText` and `newText` and nothing else (another tool's edit has other keys). */
function isStreamedEdit(value: unknown): value is StreamedEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== "oldText" && key !== "newText")) return false;
  const { oldText, newText } = value as Record<string, unknown>;
  return (
    (oldText === undefined || typeof oldText === "string") && (newText === undefined || typeof newText === "string")
  );
}

/**
 * An edit call's replacements in the shapes pi's edit tool accepts: an `edits` array, one edit
 * object, the array as a JSON string, and the legacy top-level `oldText`/`newText`. Undefined
 * when the arguments hold none of these, or something else besides.
 */
export function streamedEdits(args: Record<string, unknown>): StreamedEdit[] | undefined {
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      // A JSON string still being written: its fields show it as it comes.
      return undefined;
    }
  }
  const list: unknown[] = Array.isArray(edits) ? [...edits] : edits === undefined ? [] : [edits];
  if (typeof args.oldText === "string" || typeof args.newText === "string")
    list.push({ oldText: args.oldText, newText: args.newText });
  if (!list.length || !list.every(isStreamedEdit)) return undefined;
  return list as StreamedEdit[];
}

/** An argument's text: strings as written, everything else as indented JSON. */
function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2) ?? "";
}

/**
 * The view of a call's arguments, or undefined when there is nothing beyond its header to show.
 * `hiddenTitle` is what the header could not show of a shell command: the command's whole text.
 */
export function callView(name: string, args: Record<string, unknown> = {}, hiddenTitle?: string): CallView | undefined {
  if (toolMeta(name).cls === "shell") return hiddenTitle ? { kind: "command", command: hiddenTitle } : undefined;
  // A subagent's brief is the row's evidence; the rest of its arguments are the header's business.
  if (toolMeta(name).cls === "subagent") {
    const brief = args.task ?? args.prompt;
    if (typeof brief === "string" && brief.trim()) return { kind: "text", text: brief };
  }
  if (name === "edit") {
    const edits = streamedEdits(args);
    if (edits) {
      const written = edits.filter((edit) => edit.oldText || edit.newText);
      if (!written.length) return undefined;
      return { kind: "edit", ...(typeof args.path === "string" ? { path: args.path } : {}), edits: written };
    }
  }
  const shown = titleKey(name, args);
  const fields = Object.entries(args)
    .filter(([key, value]) => key !== shown && value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: fieldText(value) }))
    .filter((field) => field.value !== "");
  return fields.length ? { kind: "fields", fields } : undefined;
}
