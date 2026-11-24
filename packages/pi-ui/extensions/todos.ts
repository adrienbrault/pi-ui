/**
 * The todos panel: pi-ui draws the session's todo list above the editor, in place of pi-code's
 * plain one.
 *
 * The list is pi-code's: its `todo` tool puts the whole list in every result's details, and
 * persists snapshots in `pi-code:todo` session entries. Both are read here, so a resumed session
 * keeps its panel; a session without them leaves the key alone, and whatever widget was there
 * stays.
 *
 * pi keeps extension widgets in one keyed map, whoever named the key, so taking `todos` means
 * pi-code's panel does not draw as well. pi-code re-registers its own after an invalidate (a
 * resize, `/reload`); pi-ui loads after it, so this re-asserts the key on structural events, the
 * next of which takes it back.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { glyphsFor } from "../render/glyphs.ts";
import type { RenderTheme } from "../render/kit.ts";
import { renderTodosPanel, type TodoItem, type TodoStatus } from "../render/todos.ts";
import { KIT } from "./kit.ts";

const GLYPHS = glyphsFor("unicode");
/** pi-code's widget key and state entry: the same key is how our panel replaces its own. */
const WIDGET_KEY = "todos";
const STATE_ENTRY = "pi-code:todo";

let ui: ExtensionContext["ui"] | undefined;
let todos: TodoItem[] = [];

/** The spinner frame of pi's own repaints; pi-ui never repaints for decoration. */
function frame(): number {
  return Math.floor(Date.now() / 100) % GLYPHS.spinner.length;
}

/** The todos a details object or a session entry carries, if it carries any. */
function readTodos(value: unknown): TodoItem[] | undefined {
  const list = (value as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(list)) return undefined;
  const read: TodoItem[] = [];
  for (const raw of list) {
    const todo = raw as { id?: unknown; text?: unknown; status?: unknown; activeForm?: unknown; done?: unknown };
    if (typeof todo.id !== "number" || typeof todo.text !== "string") return undefined;
    const status: TodoStatus =
      todo.status === "in_progress" || todo.status === "completed"
        ? todo.status
        : todo.done === true
          ? "completed"
          : "pending";
    read.push({
      id: todo.id,
      text: todo.text,
      status,
      ...(typeof todo.activeForm === "string" ? { activeForm: todo.activeForm } : {}),
    });
  }
  return read;
}

/** The list a resumed session starts with: the last snapshot, else the last todo result. */
function replay(ctx: ExtensionContext): TodoItem[] {
  let fromSnapshot: TodoItem[] | undefined;
  let fromResult: TodoItem[] | undefined;
  type Entry = {
    type?: string;
    customType?: string;
    data?: unknown;
    message?: { role?: string; toolName?: string; details?: unknown };
  };
  // A context that keeps no history (another mode, a stub) has no list to replay.
  const manager = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager;
  for (const entry of (manager?.getBranch?.() ?? []) as Entry[]) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      const read = readTodos(entry.data);
      if (read) fromSnapshot = read;
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo") {
      const read = readTodos(entry.message.details);
      if (read) fromResult = read;
    }
  }
  return fromSnapshot ?? fromResult ?? [];
}

/** Draws the panel, or hides it when the session has no todos. */
function paint(): void {
  if (!ui) return;
  if (!todos.length) {
    ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  ui.setWidget(
    WIDGET_KEY,
    (_tui, theme) =>
      renderTodosPanel({ kit: KIT, theme: theme as unknown as RenderTheme, glyphs: GLYPHS }, () => ({
        todos,
        frame: frame(),
      })),
    { placement: "aboveEditor" },
  );
}

export function installTodos(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    ui = ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;
    todos = replay(ctx);
    paint();
  });

  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "todo") return;
    const read = readTodos((event.result as { details?: unknown } | undefined)?.details);
    if (!read) return;
    todos = read;
    paint();
  });

  // pi-code re-registers its widget after an invalidate; these are the events both extensions
  // already handle, ours after its, so the key comes back to this panel.
  pi.on("message_start", () => paint());
  pi.on("tool_execution_start", () => paint());
  pi.on("turn_end", () => paint());
  pi.on("agent_settled", () => paint());

  pi.on("session_shutdown", () => {
    ui = undefined;
    todos = [];
  });
}
