/**
 * The todos panel: the session's todo list above the editor, drawn in pi-ui's vocabulary.
 *
 * The heading counts the work and draws its share as a bar; a row per todo keeps the panel's `#id`s
 * matching the transcript's todo calls. Rows keep the order the agent wrote them, completed ones
 * dimmed, the one in progress carrying the frame pi is already repainting. Over the panel's budget
 * the completed rows leave first, counted into the notice the budget pays for, so the panel never
 * grows past `TODOS_PANEL_LINES`.
 *
 * Pure: the list and the spinner frame are inputs, read at render time so a plain repaint moves
 * the spinner. `bun run ds` renders the same cards from fixed frames.
 */

import { frameAt } from "./glyphs.ts";
import { omissionStyle, type ComponentLike } from "./kit.ts";
import type { RenderApi } from "./tool-row.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

/** A todo as the tool keeps it: pi-code's shape, which a todo result's details carry. */
export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  /** What the agent is doing for it now, when it says more than the todo's text. */
  activeForm?: string;
}

export interface TodosPanelInput {
  todos: TodoItem[];
  /** Spinner frame: the extension reads pi's clock, a fixture pins one. */
  frame?: number;
}

/** Content lines the panel may take, its heading and any omission notice included. */
export const TODOS_PANEL_LINES = 10;
/** Progress-bar cells: one per todo up to this many, so a long list keeps a short bar. */
export const TODOS_BAR_CELLS = 8;

/** The bar's cells: how many fill, out of how many. One per todo, capped. */
export function todoBar(done: number, total: number): { filled: number; cells: number } {
  const cells = Math.min(Math.max(total, 1), TODOS_BAR_CELLS);
  if (total <= 0) return { filled: 0, cells };
  return { filled: Math.min(cells, Math.round((done / total) * cells)), cells };
}

/**
 * The panel. A session with no todos draws nothing, so the caller can leave whatever panel was
 * there alone; a finished list keeps one line, since the work it reports is worth a glance.
 */
export function renderTodosPanel(api: RenderApi, read: () => TodosPanelInput): ComponentLike {
  return api.kit.component((width) => todosLines(api, read(), width));
}

/** The panel's rows for one render: exported so a test reads them without a component. */
export function todosLines(api: RenderApi, input: TodosPanelInput, width: number): string[] {
  const { theme, glyphs, kit } = api;
  const todos = input.todos;
  if (!todos.length || width < 8) return [];
  const cut = (line: string) => kit.truncateToWidth(line, width, "…");
  const done = todos.filter((todo) => todo.status === "completed").length;

  if (done === todos.length) {
    return [cut(`${theme.fg("dim", glyphs.pending)} ${theme.fg("dim", `Todos ${done}/${todos.length} · done`)}`)];
  }

  const { filled, cells } = todoBar(done, todos.length);
  const bar =
    theme.fg("success", glyphs.barFill.repeat(filled)) + theme.fg("dim", glyphs.barEmpty.repeat(cells - filled));
  const head = cut(
    `${theme.fg("accent", glyphs.success)} ${theme.fg("accent", "Todos")} ${theme.fg("muted", `${done}/${todos.length}`)}  ${bar}`,
  );

  const rows = todos.map((todo) => {
    const mark = markOf(api, todo, input.frame);
    const id = theme.fg("dim", `#${todo.id}`);
    const label =
      todo.status === "completed"
        ? theme.fg("dim", todo.text)
        : todo.status === "in_progress"
          ? theme.fg("text", todo.text)
          : theme.fg("muted", todo.text);
    // What the agent is doing right now, when the active form adds to the todo's own words.
    const doing =
      todo.status === "in_progress" && todo.activeForm && todo.activeForm !== todo.text
        ? ` ${theme.fg("dim", `(${todo.activeForm})`)}`
        : "";
    return `  ${mark} ${id} ${label}${doing}`;
  });

  const fitted = todos.length + 1 <= TODOS_PANEL_LINES ? rows : fittedRows(api, input, rows);

  return [head, ...fitted.map(cut)];
}

/** The todo's glyph: a check for done work, the spinner while it runs, a circle until then. */
function markOf(api: RenderApi, todo: TodoItem, frame: number | undefined): string {
  const { theme, glyphs } = api;
  switch (todo.status) {
    case "completed":
      return theme.fg("success", glyphs.done);
    case "in_progress":
      return theme.fg("accent", frameAt(glyphs, frame));
    case "pending":
      return theme.fg("dim", glyphs.pending);
  }
}

/**
 * A list too long for the panel: the work keeps its rows first, the completed rows fill what is
 * left, and whatever is left out is counted into one notice — inside the budget, not on top of it.
 */
function fittedRows(api: RenderApi, input: TodosPanelInput, rows: string[]): string[] {
  const { theme, glyphs } = api;
  const room = TODOS_PANEL_LINES - 2; // the heading and the notice
  const todos = input.todos;
  const kept = new Set<number>();
  for (const wantDone of [false, true])
    todos.forEach((todo, index) => {
      if ((todo.status === "completed") === wantDone && kept.size < room) kept.add(index);
    });

  const hidden = todos.filter((_, index) => !kept.has(index));
  const completed = hidden.filter((todo) => todo.status === "completed").length;
  const pending = hidden.length - completed;
  const parts = [completed ? `${completed} completed` : "", pending ? `${pending} pending` : ""].filter(Boolean);
  const notice = omissionStyle(theme, `${glyphs.between} ${hidden.length} more · ${parts.join(", ")}`);

  return [...todos.flatMap((_, index) => (kept.has(index) ? [rows[index]!] : [])), notice];
}
