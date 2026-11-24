import { describe, expect, test } from "bun:test";
import { installTodos } from "./todos.ts";

/** pi's Theme, as far as a panel uses it. */
const THEME = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  style: (text: string) => text,
};

const TODO_STATE = (todos: unknown[]) => ({
  type: "custom",
  customType: "pi-code:todo",
  data: { todos, nextId: todos.length + 1 },
});

interface Call {
  content?: unknown;
  options?: { placement?: string };
}

/** Installs the panel on a fake pi, returning its handlers and the widget writes it made. */
function install(branch: unknown[] = []) {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
  installTodos({
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
    },
  } as never);
  const calls: Call[] = [];
  const ui = {
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
      expect(key).toBe("todos");
      calls.push({ content, options });
    },
  };
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui,
    sessionManager: { getBranch: () => branch },
  };
  const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
  shutdown();
  return { handlers, calls, ctx, shutdown };
}

/** The lines the panel last drew at this width. */
function panel(calls: Call[], width = 80): string[] {
  const content = calls.at(-1)?.content;
  if (typeof content !== "function") return [];
  const component = (content as (tui: unknown, theme: unknown) => { render: (width: number) => string[] })(
    { requestRender: () => {} },
    THEME,
  );
  return component.render(width);
}

describe("todos panel", () => {
  test("a session's own snapshot is drawn above the editor, and the key is pi-code's", () => {
    const { handlers, calls, ctx } = install([
      TODO_STATE([
        { id: 1, text: "Commit A", status: "completed" },
        { id: 2, text: "Committing the harness", status: "in_progress", activeForm: "Committing the replay harness" },
        { id: 3, text: "Commit C", status: "pending" },
      ]),
    ]);
    handlers.get("session_start")?.({}, ctx);
    expect(calls.at(-1)?.options).toEqual({ placement: "aboveEditor" });
    const lines = panel(calls);
    expect(lines[0]).toBe("● Todos 1/3  ▰▱▱");
    expect(lines[1]).toBe("  ✓ #1 Commit A");
    expect(lines[2]).toMatch(/^ {2}\S #2 Committing the harness \(Committing the replay harness\)$/);
    expect(lines[3]).toBe("  ○ #3 Commit C");
  });

  test("the last todo result carries the list when no snapshot does", () => {
    const { handlers, calls, ctx } = install([
      { type: "message", message: { role: "user" } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: { action: "start", todos: [{ id: 7, text: "Write the panel", status: "in_progress" }] },
        },
      },
    ]);
    handlers.get("session_start")?.({}, ctx);
    expect(panel(calls)[1]).toMatch(/^ {2}\S #7 Write the panel$/);
  });

  test("a todo call's result replaces the list, and the panel is redrawn", () => {
    const { handlers, calls, ctx } = install([TODO_STATE([{ id: 1, text: "First", status: "pending" }])]);
    handlers.get("session_start")?.({}, ctx);
    const before = calls.length;
    handlers.get("tool_execution_end")?.({
      toolName: "todo",
      result: { details: { action: "start", todos: [{ id: 1, text: "First", status: "in_progress" }] } },
    });
    expect(calls.length).toBe(before + 1);
    expect(panel(calls)[1]).toMatch(/^ {2}\S #1 First$/);
  });

  test("another tool's result, or one without a list, leaves the panel as it was", () => {
    const { handlers, calls, ctx } = install();
    handlers.get("session_start")?.({}, ctx);
    const before = calls.length;
    handlers.get("tool_execution_end")?.({ toolName: "bash", result: { details: {} } });
    handlers.get("tool_execution_end")?.({ toolName: "todo", result: { content: [{ type: "text", text: "x" }] } });
    expect(calls.length).toBe(before);
  });

  test("a session with no todos hides the panel, leaving pi-code's own to hide itself", () => {
    const { handlers, calls, ctx } = install();
    handlers.get("session_start")?.({}, ctx);
    expect(calls.at(-1)?.content).toBeUndefined();
  });

  test("a session without a UI draws nothing", () => {
    const { handlers, calls, ctx } = install([TODO_STATE([{ id: 1, text: "First", status: "pending" }])]);
    handlers.get("session_start")?.({}, { ...ctx, hasUI: false });
    expect(calls).toHaveLength(0);
  });
});
