import { beforeAll, describe, expect, jest, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  rgbColor,
  stripTerminalSequences,
  styleText,
  type TextStyle,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { highlightGroupRow } from "./hover.ts";
import { toolPlan } from "./fold.ts";
import prism, { actionFor, hintFor } from "./index.ts";

// Syntax highlighting reads pi's global theme; do not depend on another test file installing it.
beforeAll(() => initTheme("dark"));

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  bg: (_token: string, text: string) => text,
  style: (text: string) => text,
  colors: { accent: "accent", toolPendingBg: "bg" },
};

const ctx = {
  args: { command: "bun test" },
  state: undefined as unknown as { expansion: number; hover: boolean },
  isPartial: false,
  isError: false,
  executionStarted: true,
  durationMs: 8.7,
  invalidate: () => {},
};

const click = (): TuiMouseEvent => ({
  type: "click",
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 80,
  height: 10,
  shift: false,
  alt: false,
  ctrl: false,
});

const output = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
const result = { content: [{ type: "text", text: output }] };

interface Row {
  render(width: number): string[];
  handleMouse?(event: TuiMouseEvent): unknown;
}

interface Renderers {
  renderCall(args: unknown, theme: unknown, ctx: unknown): Row;
  renderResult(result: unknown, options: unknown, theme: unknown, ctx: unknown): Row;
}

function resolver(
  on: (name: string, handler: (...args: any[]) => void) => void = () => {},
): (name: string, next: () => unknown) => Renderers | unknown {
  let captured: unknown;
  prism({
    registerToolRenderer: (r: unknown) => {
      captured = r;
    },
    on,
  } as never);
  return captured as (name: string, next: () => unknown) => Renderers | unknown;
}

/** Tool rows followed by enough non-tool transcript content to put them in history. */
function historyViewport(children: object[], onVisit?: () => void) {
  return {
    get children() {
      onVisit?.();
      return children;
    },
    terminal: { rows: 10 },
    get mouseLayout() {
      return { children: [...children.map((component) => ({ component, height: 2 })), { component: {}, height: 10 }] };
    },
  };
}

describe("expansion cycle", () => {
  test("nothing to reveal means no step", () => {
    expect(actionFor(0, 4)).toBeNull();
    expect(hintFor(0, 4)).toBeNull();
  });

  test("hints name the next action", () => {
    expect(hintFor(0, 40)).toBe("click · expand");
    expect(hintFor(1, 40)).toBe("click · collapse");
    expect(hintFor(1, 12)).toBe("click · collapse");
  });

  test("clicks follow the action, not a blind cycle", () => {
    expect(actionFor(0, 40)).toBe(1);
    expect(actionFor(1, 12)).toBe(0);
  });

  test("an aged row only expands past its own budget", () => {
    expect(actionFor(0, 7, 2)).toBe(1);
    expect(actionFor(0, 6, 2)).toBeNull();
  });
});

/** A theme whose scroll bar cells are visible in the output: thumb 1, track 2. */
const barred = {
  ...theme,
  colors: { ...theme.colors, scrollbarThumb: "1", scrollbarTrack: "2" },
  style: (text: string, options?: { bg?: string }) => (options?.bg ? `\x1b[48;5;${options.bg}m${text}\x1b[49m` : text),
};
const hasBar = (rows: string[]) => rows.some((row) => row.includes("\x1b[48;5;"));

const plainRows = (rows: string[]) => rows.map((row) => stripTerminalSequences(row).trimEnd());

const move = (): TuiMouseEvent => ({ ...click(), type: "move", button: "none" });

const fadeTheme = {
  ...theme,
  colors: { ...theme.colors, toolOutput: rgbColor(210, 210, 210), toolPendingBg: rgbColor(0, 0, 0) },
  // Renderers also pass token names; only colours resolve, as in the fade.
  style: (text: string, options: TextStyle) =>
    typeof options.fg === "object" ? styleText(text, { fg: options.fg }, "truecolor") : text,
};

/** A live session under fake timers whose transcript is tool shells of one kind. */
function fadeSession(name: string, text = output, onVisit?: () => void) {
  jest.useFakeTimers();
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const dispatch = (event: string, ...args: unknown[]) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };
  const tool = resolver((event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]))(
    name,
    () => undefined,
  ) as Renderers;
  const children: object[] = [];
  dispatch(
    "session_start",
    {},
    {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: (_: string, factory?: (root: object, theme: object) => void) =>
          factory?.(
            {
              get children() {
                onVisit?.();
                return children;
              },
            },
            fadeTheme,
          ),
      },
    },
  );
  const add = (toolCallId: string) => {
    const args = name === "read" ? { path: "notes.txt" } : ctx.args;
    const context = { ...ctx, args, toolCallId, state: {} };
    const header = tool.renderCall(args, fadeTheme, context);
    const body = tool.renderResult({ content: [{ type: "text", text }] }, {}, fadeTheme, context);
    const shell = {
      toolCallId,
      toolName: name,
      rendererState: {},
      selfRenderHeight: 8,
      handleMouse() {},
      render: (w: number) => [...header.render(w), ...body.render(w)],
    };
    children.push(shell);
    return shell;
  };
  const close = () => {
    dispatch("session_shutdown", "");
    jest.useRealTimers();
  };
  return { add, dispatch, close };
}

describe("tool renderers", () => {
  test("leaves unowned tools to the next resolver", () => {
    const base = { renderShell: "default" };
    for (const name of ["todo", "subagent", "ask_user_question", "codemode", "tool_search", "web", "fetch"]) {
      expect(resolver()(name, () => base)).toBe(base);
    }
  });

  test("owns every classified tool it renders, so they fold with their peers", () => {
    const base = { renderShell: "default" };
    for (const name of [
      "read",
      "ls",
      "grep",
      "find",
      "ffgrep",
      "fffind",
      "multi_grep",
      "write",
      "edit",
      "bash",
      "powershell",
      "web_fetch",
      "web_search",
      "fetch_content",
      "mcp__memory__search",
    ]) {
      expect(resolver()(name, () => base)).not.toBe(base);
    }
  });

  test("hovering a tool paints no chip, and any row opens and closes it", () => {
    const renderers = resolver()("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {} };
    const header = renderers.renderCall(ctx.args, theme, context);
    const body = renderers.renderResult(result, {}, theme, context);

    body.handleMouse?.({ ...move(), y: 6 });
    expect([...header.render(80), ...body.render(80)].join("\n")).not.toContain("[ click");
    body.handleMouse?.({ ...click(), y: 2 });
    expect(body.render(80)).toHaveLength(40);
    expect(body.render(80).join("\n")).not.toContain("[ click");
    body.handleMouse?.({ ...click(), y: 20 });
    expect(body.render(80)).toHaveLength(8);
  });

  test("a grouped hover covers the indent, gap and trailing cells on just the pointed row", () => {
    const bg = "\x1b[45m";
    const rows = ["summary", "  bash\x1b[0m    8ms", "next"];
    expect(highlightGroupRow(rows, 1, 16, bg)).toEqual([
      "summary",
      bg + "  bash\x1b[0m" + bg + "    8ms   \x1b[49m",
      "next",
    ]);
  });

  test("hover leaves the heading and the footer unpainted", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {} };
    const painted = { ...theme, bg: (_token: string, text: string) => "\x1b[45m" + text + "\x1b[49m" };
    const header = tool.renderCall(ctx.args, painted, context);
    const body = tool.renderResult(result, {}, painted, context);
    for (const target of [header, body]) {
      target.handleMouse?.({ ...move(), y: target === body ? 6 : 0 });
      expect([...header.render(80), ...body.render(80)].join("\n")).not.toContain("\x1b[45m");
    }
  });

  test("hovering a block that can open shows where its preview sits in the whole output", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {} };
    tool.renderCall(ctx.args, barred, context);
    const body = tool.renderResult(result, {}, barred, context);
    const idle = body.render(80);
    expect(idle.some((row) => row.includes("48;5;"))).toBe(false);
    body.handleMouse?.({ ...move(), y: 1 });
    const hovered = body.render(80);
    // Seven of 40 lines shown, all at the end: each cell stands for five lines, so the last two fill.
    const cells = hovered.map((row) => (row.includes("48;5;1m") ? "fill" : row.includes("48;5;2m") ? "track" : "none"));
    expect(cells).toEqual(["track", "track", "track", "track", "track", "track", "fill", "fill"]);
    expect(plainRows(hovered)).toEqual(plainRows(idle));
  });

  test("only one hovered block shows its bar", () => {
    const renderers = resolver()("bash", () => undefined) as Renderers;
    const first = { ...ctx, args: { command: "first" }, state: undefined as unknown as object };
    renderers.renderCall(first.args, barred, first);
    const firstBody = renderers.renderResult(result, {}, barred, first);
    firstBody.handleMouse?.({ ...move(), y: 6 });
    expect(hasBar(firstBody.render(80))).toBe(true);

    const second = { ...ctx, args: { command: "second" }, state: undefined as unknown as object };
    renderers.renderCall(second.args, barred, second);
    const secondBody = renderers.renderResult(result, {}, barred, second);
    secondBody.handleMouse?.({ ...move(), y: 6 });
    expect(hasBar(secondBody.render(80))).toBe(true);
    expect(hasBar(firstBody.render(80))).toBe(false);
  });

  test("write previews streamed arguments before a result and expands the completed source", () => {
    const tool = resolver()("write", () => undefined) as Renderers;
    const args = { path: "sample.txt", content: "first line" };
    const context = { ...ctx, args, state: {}, isPartial: true, executionStarted: false };
    expect(tool.renderCall(args, theme, context).render(80).join("\n")).toContain("first line");
    args.content = output;
    expect(tool.renderCall(args, theme, context).render(80).join("\n")).toContain("line 40");
    context.isPartial = false;
    context.executionStarted = true;
    const call = tool.renderCall(args, theme, context);
    const receipt = tool.renderResult(
      { content: [{ type: "text", text: "Successfully wrote sample.js" }] },
      {},
      theme,
      context,
    );
    expect(receipt.render(80)).toEqual([]);
    const preview = call.render(80);
    const cut = preview.findIndex((line) => line.includes("+ 33 lines"));
    expect(preview[cut - 1]).toContain("line 4");
    expect(preview.at(-1)).toContain("line 40");
    call.handleMouse?.({ ...click(), y: cut });
    expect(
      call
        .render(80)
        .slice(1)
        .map((line) => line.trim()),
    ).toEqual(output.split("\n"));
  });

  test("a clipped silent bash command opens in full and closes again", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const command = "echo " + "abcdefghij".repeat(12) + "\necho second";
    const context = { ...ctx, args: { command }, state: {} };
    const header = tool.renderCall(context.args, theme, context);
    const body = tool.renderResult({ content: [] }, {}, theme, context);
    expect(header.render(40)[0]).toContain("…");
    expect(body.render(40)).toEqual([]);
    header.handleMouse?.(click());
    const rows = body.render(40);
    expect(rows[0]?.trim()).toBe("echo");
    expect(
      rows
        .slice(1, -1)
        .map((row) => row.slice(4))
        .join(""),
    ).toBe("abcdefghij".repeat(12));
    expect(rows.at(-1)?.trim()).toBe("echo second");
    header.handleMouse?.(click());
    expect(body.render(40)).toEqual([]);
  });

  test("a single clipped output line offers expand and wraps when opened", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const text = Array.from({ length: 30 }, (_, index) => `token${index}`).join(" ");
    const context = { ...ctx, state: {} };
    const header = tool.renderCall(context.args, barred, context);
    const body = tool.renderResult({ content: [{ type: "text", text }] }, {}, barred, context);
    const preview = body.render(60);
    expect(preview).toHaveLength(1);
    expect(preview[0]).toContain("…");
    body.handleMouse?.({ ...click(), type: "move", y: 0 });
    expect(hasBar(body.render(60))).toBe(true);
    body.handleMouse?.({ ...click(), y: 0 });
    const open = body.render(60);
    expect(open.length).toBeGreaterThan(1);
    expect(open.join(" ")).toContain("token29");
    header.handleMouse?.(click());
    // Collapsed again; the pointer still rests on the row, so its bar stays lit.
    expect(body.render(60)).toHaveLength(1);
    expect(hasBar(body.render(60))).toBe(true);
  });

  test("owned tools claim the row and grow the body on click", () => {
    const renderers = resolver()("bash", () => undefined) as Renderers;
    const header = renderers.renderCall(ctx.args, theme, ctx);
    const body = renderers.renderResult(result, {}, theme, ctx);

    expect(header.render(80)).toHaveLength(1);
    expect(body.render(80).length).toBeLessThan(16);

    // One click shows the whole output; the next collapses it again.
    header.handleMouse?.(click());
    const full = body.render(80).length;
    header.handleMouse?.(click());
    const back = body.render(80).length;

    expect(full).toBe(40);
    expect(back).toBeLessThan(full);
  });

  test("silent bash calls repaint on separate clocks and freeze at the reported duration", () => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const tool = resolver((name, handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    })("bash", () => undefined) as Renderers;
    const dispatch = (name: string, toolCallId: string) => {
      for (const handler of handlers.get(name) ?? [])
        handler({ toolName: "bash", toolCallId }, { mode: "tui", hasUI: true });
    };
    const paints: string[] = [];
    const context = {
      ...ctx,
      toolCallId: "silent",
      state: {},
      isPartial: true,
      executionStarted: false,
      durationMs: undefined,
      invalidate: () => paints.push(header.render(80)[0]!),
    };
    let header = tool.renderCall(ctx.args, theme, context);
    jest.useFakeTimers();
    try {
      jest.advanceTimersByTime(2000);
      expect(header.render(80)[0]).not.toMatch(/\d+s$/);
      dispatch("tool_execution_start", "silent");
      context.executionStarted = true;
      header = tool.renderCall(ctx.args, theme, context);
      jest.advanceTimersByTime(7000);
      dispatch("tool_execution_start", "other");
      const other = tool.renderCall(ctx.args, theme, { ...context, toolCallId: "other", invalidate: () => {} });
      tool.renderResult(result, {}, theme, context);
      jest.advanceTimersByTime(200);
      expect(paints.at(-1)).toEndWith("7.2s");
      expect(other.render(80)[0]).toEndWith("200ms");
      dispatch("tool_execution_end", "silent");
      header = tool.renderCall(ctx.args, theme, { ...context, isPartial: false, durationMs: 7100 });
      const finalPaintCount = paints.length;
      jest.advanceTimersByTime(500);
      expect(paints).toHaveLength(finalPaintCount);
      expect(header.render(80)[0]).toEndWith("7.1s");
      expect(other.render(80)[0]).toEndWith("700ms");
    } finally {
      dispatch("session_shutdown", "");
      jest.useRealTimers();
    }
  });

  test("a restored failure without a duration keeps its error header", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {}, isError: true, durationMs: undefined };
    const header = tool.renderCall(ctx.args, theme, context);
    tool.renderResult({ content: [{ type: "text", text: "stderr\nexit code 2" }] }, {}, theme, context);
    expect(header.render(80)[0]).toContain("exit code 2");
  });

  test("tool estimates follow streaming arguments and model-visible result content", () => {
    const tool = resolver()("edit", () => undefined) as Renderers;
    const context = { ...ctx, args: { path: "test" }, state: {}, isPartial: true };
    const header = tool.renderCall(context.args, theme, context);
    expect(header.render(120)[0]).toContain("5 out / 0 in tokens");
    tool.renderCall({ path: "test-long" }, theme, context);
    expect(header.render(120)[0]).toContain("6 out / 0 in tokens");
    const content = [
      { type: "text", text: "abcde" },
      { type: "image", mimeType: "image/png", data: "abcd" },
    ];
    tool.renderResult({ content, details: { diff: "+ display only" } }, {}, theme, context);
    expect(header.render(120)[0]).toContain("5 out / 1202 in tokens");
  });

  test("edits show the structured diff, with text as a fallback", () => {
    const tool = resolver()("edit", () => undefined) as Renderers;
    const context = { ...ctx, args: { path: "a.ts" }, state: {} };
    const content = [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }];
    const body = tool.renderResult({ content, details: { diff: "-1 before\n+1 after" } }, {}, theme, context);
    expect(body.render(80).map((line) => line.trimEnd())).toEqual(["    -1 before", "    +1 after"]);
    expect(tool.renderResult({ content }, {}, theme, context).render(80)[0]).toContain("Successfully replaced");
  });

  test("visible tools paint successive fade frames before shrinking and before entering a group", () => {
    const session = fadeSession("bash");
    try {
      const oldest = session.add("animated-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      for (let i = 1; i <= 5; i++) {
        session.add("animated-" + i);
        session.dispatch("agent_settled");
        const first = oldest.render(80);
        jest.advanceTimersByTime(90);
        const second = oldest.render(80);
        expect(second.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences));
        expect(second.filter((line, index) => line !== first[index])).toHaveLength(1);
        expect(second.join("")).toContain("38;2;140;140;140");
        if (i === 5) {
          jest.advanceTimersByTime(270);
          for (let height = first.length - 1; height > 0; height--) {
            expect(oldest.render(80).map(stripTerminalSequences)).toEqual(
              first.slice(0, height).map(stripTerminalSequences),
            );
            jest.advanceTimersByTime(360);
          }
        }
        jest.advanceTimersByTime(10000);
        expect(oldest.render(80).length).toBeLessThan(first.length);
      }
      expect(toolPlan(oldest.toolCallId)?.mode).toBe("anchor");
    } finally {
      session.close();
    }
  });

  test("a read fades the line that leaves, not the notice at its cut", () => {
    const session = fadeSession("read");
    try {
      const oldest = session.add("read-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      for (let step = 1; step <= 4; step++) {
        session.add("read-" + step);
        session.dispatch("agent_settled");
        const first = oldest.render(80);
        jest.advanceTimersByTime(90);
        const fading = oldest.render(80).filter((line, index) => line !== first[index]);
        expect(fading).toHaveLength(1);
        const line = stripTerminalSequences(fading[0]!).trim();
        expect(line).toMatch(/^line \d+$/);
        jest.advanceTimersByTime(10000);
        expect(oldest.render(80).map((row) => stripTerminalSequences(row).trim())).not.toContain(line);
      }
    } finally {
      session.close();
    }
  });

  test("a fade tick repaints one block instead of walking the transcript", () => {
    let visits = 0;
    const session = fadeSession("bash", output, () => visits++);
    try {
      session.add("walk-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      // The new row's registration schedules the walk that starts the fade.
      session.add("walk-1");
      jest.advanceTimersByTime(1);
      const before = visits;
      session.dispatch("agent_settled");
      const walk = visits - before;
      expect(walk).toBeGreaterThan(0);
      jest.advanceTimersByTime(300);
      expect(visits).toBe(before + walk);
      jest.advanceTimersByTime(60);
      expect(toolPlan("walk-0")?.level).toBe(1);
      expect(visits).toBe(before + 2 * walk);
    } finally {
      session.close();
    }
  });

  test("blocks more than one step behind catch up without animation", () => {
    const session = fadeSession("bash");
    try {
      session.add("burst-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      // Four new blocks inside one 360 ms fade.
      for (let index = 1; index <= 4; index++) {
        session.add("burst-" + index);
        jest.advanceTimersByTime(1);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(20);
      }
      // The fading block finishes its row and takes its target; each other block animates one step at most.
      jest.advanceTimersByTime(4 * 360);
      expect([0, 1, 2, 3, 4].map((index) => toolPlan("burst-" + index)?.level)).toEqual([4, 3, 2, 1, 0]);
    } finally {
      session.close();
    }
  });

  test("a fast session fades its rows faster", () => {
    const session = fadeSession("read");
    try {
      // Three tool starts 400 ms apart: a row fades over 100 ms, not 360.
      for (const id of ["pace-0", "pace-1", "pace-2"]) {
        session.dispatch("tool_execution_start", { toolCallId: id, toolName: "read" }, { mode: "tui" });
        jest.advanceTimersByTime(400);
      }
      session.add("quick-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      session.add("quick-1");
      jest.advanceTimersByTime(1);
      jest.advanceTimersByTime(74);
      expect(toolPlan("quick-0")?.level).toBe(0);
      jest.advanceTimersByTime(26);
      expect(toolPlan("quick-0")?.level).toBe(1);
    } finally {
      session.close();
    }
  });

  test("a tool whose next level keeps every line steps on the first tick", () => {
    const session = fadeSession("bash", "one\ntwo");
    try {
      const oldest = session.add("short-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      session.add("short-1");
      session.dispatch("agent_settled");
      const first = oldest.render(80);
      jest.advanceTimersByTime(90);
      expect(oldest.render(80)).toEqual(first);
      jest.advanceTimersByTime(90);
      expect(toolPlan("short-0")?.level).toBe(1);
    } finally {
      session.close();
    }
  });

  test("partial output leaves the tree alone and two structural passes settle a tool's level", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const dispatch = (name: string, ...args: unknown[]) => {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    };
    const tool = resolver((name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    })("bash", () => undefined) as Renderers;
    const children = [{ toolCallId: "older", toolName: "bash", rendererState: {} }];
    let visits = 0;
    const tui = historyViewport(children, () => visits++);
    dispatch(
      "session_start",
      {},
      {
        hasUI: true,
        mode: "tui",
        ui: { setWidget: (_: string, factory?: (root: object, theme: object) => void) => factory?.(tui, theme) },
      },
    );
    const older = { ...ctx, toolCallId: "older", state: {}, durationMs: undefined, isPartial: true };
    const body = tool.renderResult(result, {}, theme, older);
    await Bun.sleep(10);
    const beforeUpdates = visits;
    expect(beforeUpdates).toBeGreaterThan(0);
    tool.renderResult({ content: [{ type: "text", text: output + "\nmore" }] }, {}, theme, older);
    await Bun.sleep(10);
    expect(visits).toBe(beforeUpdates);

    children.push({ ...children[0]!, toolCallId: "newer" });
    tool.renderCall(ctx.args, theme, { ...ctx, toolCallId: "newer", state: {} });
    await Bun.sleep(10);
    expect(body.render(80)).toHaveLength(8);
    dispatch("agent_settled");
    expect(body.render(80)).toHaveLength(7);
  });

  test("open members survive turn boundaries and a growing live group", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const dispatch = (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    };
    const tool = resolver((event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    })("read", () => undefined) as Renderers;
    const children: Array<{ toolCallId: string; toolName: string; rendererState: object }> = [];
    dispatch(
      "session_start",
      {},
      {
        hasUI: true,
        mode: "tui",
        ui: {
          setWidget: (_: string, factory?: (root: object, theme: object) => void) =>
            factory?.(historyViewport(children), theme),
        },
      },
    );
    const add = (index: number) => {
      const toolCallId = `growing-${index}`;
      children.push({ toolCallId, toolName: "read", rendererState: {} });
      const context = { ...ctx, args: { path: `file-${index}` }, toolCallId, state: {}, durationMs: 500 };
      tool.renderResult(result, {}, theme, context);
      dispatch("message_end", { message: { role: "toolResult", toolCallId, timestamp: 2000 + index * 100 } });
      return () => tool.renderCall(context.args, theme, context);
    };
    const headers = Array.from({ length: 7 }, (_, index) => add(index));
    await Bun.sleep(10);
    // A small group of the current run already lists its members.
    expect(toolPlan("growing-0")?.group?.forming).toBe(true);
    const member = headers[1]!;
    member().handleMouse?.(click());
    expect(member().render(80)).toHaveLength(41);
    add(7);
    dispatch("turn_end");
    dispatch("turn_start");
    expect(member().render(80)).toHaveLength(41);
    expect(toolPlan("growing-0")?.group?.durationMs).toBe(700);
    member().handleMouse?.(click());
    expect(member().render(80)).toHaveLength(1);
  });

  test("an expanded standalone tool survives a turn boundary until clicked again", () => {
    const handlers: Array<() => void> = [];
    const tool = resolver((event, handler) => {
      if (event === "turn_end") handlers.push(handler);
    })("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {} };
    const header = tool.renderCall(ctx.args, theme, context);
    const body = tool.renderResult(result, {}, theme, context);
    body.handleMouse?.({ ...click(), y: body.render(80).length - 1 });
    expect(body.render(80)).toHaveLength(40);
    for (const handler of handlers) handler();
    expect(body.render(80)).toHaveLength(40);
    header.handleMouse?.(click());
    expect(body.render(80)).toHaveLength(8);
  });
});
