import { beforeAll, describe, expect, jest, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  rgbColor,
  stripTerminalSequences,
  styleText,
  type TextStyle,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { BLOCKS_PER_STEP, detailFor, FOLD_DISTANCE, FORMING_ROWS } from "../render/detail.ts";
import { keepGroupOpen, setGroupOpen, toolPlan } from "./fold.ts";
import { BACKLOG_MIN_MS, backlogIntervalMs, fadeDurationMs, toolFade } from "./fade.ts";
import prism, { actionFor } from "./index.ts";

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

/** The `barred` background of each visible column: "1" thumb or fill, "2" track, undefined unpainted. */
function backgrounds(row: string): Array<string | undefined> {
  const cells: Array<string | undefined> = [];
  let bg: string | undefined;
  // oxlint-disable-next-line no-control-regex -- walking SGR state is the point
  for (const [, params, text] of row.matchAll(/\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([^\x1b]+)/g)) {
    if (params === undefined && text === undefined) continue;
    if (params !== undefined) {
      const codes = params.split(";");
      if (codes[0] === "48" && codes[1] === "5") bg = codes[2];
      else if (codes.includes("49") || codes.includes("0") || params === "") bg = undefined;
    } else for (const _ of text ?? "") cells.push(bg);
  }
  return cells;
}

/** What the scroll bar shows on a row: column 1 carries it, and no other column is painted. */
function barCell(row: string): "fill" | "track" | "none" {
  const cells = backgrounds(row);
  if (cells.some((cell, column) => column !== 1 && cell !== undefined)) throw new Error(`painted off the bar: ${row}`);
  return cells[1] === "1" ? "fill" : cells[1] === "2" ? "track" : "none";
}

/** A hovered one-row item's mark: its first glyph on the thumb colour, and nothing else painted. */
function markCell(row: string): "marker" | "none" {
  const cells = backgrounds(row);
  const glyph = [...stripTerminalSequences(row)].findIndex((char) => char !== " ");
  if (cells.some((cell, column) => column !== glyph && cell !== undefined))
    throw new Error(`painted off the marker: ${row}`);
  return cells[glyph] === "1" ? "marker" : "none";
}

const plainRows = (rows: string[]) => rows.map((row) => stripTerminalSequences(row).trimEnd());

const move = (): TuiMouseEvent => ({ ...click(), type: "move", button: "none" });

const fadeTheme = {
  ...theme,
  colors: { ...theme.colors, toolOutput: rgbColor(210, 210, 210), toolPendingBg: rgbColor(0, 0, 0) },
  // Renderers also pass token names; only colours resolve, as in the fade.
  style: (text: string, options: TextStyle) =>
    typeof options.fg === "object" ? styleText(text, { fg: options.fg }, "truecolor") : text,
};

/**
 * A live session under fake timers whose transcript is tool shells of one kind.
 * With `screenRows`, the screen shows only the transcript's last rows; the rest is offscreen history.
 */
function fadeSession(name: string, text = output, onVisit?: () => void, screenRows?: number) {
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
  const start = () =>
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
                terminal: { rows: screenRows ?? 0 },
                get mouseLayout() {
                  if (screenRows === undefined) return undefined;
                  const heights = children.map((component) => ({
                    component,
                    height: (component as Row).render(80).length,
                  }));
                  return { children: heights };
                },
              },
              fadeTheme,
            ),
        },
      },
    );
  start();
  const add = (toolCallId: string) => {
    const args = name === "read" ? { path: "notes.txt" } : ctx.args;
    // pi calls the renderers again whenever a tool component is invalidated.
    const build = () => [
      tool.renderCall(args, fadeTheme, context),
      tool.renderResult({ content: [{ type: "text", text }] }, {}, fadeTheme, context),
    ];
    const context = { ...ctx, args, toolCallId, state: {}, invalidate: () => shell.invalidate() };
    let parts: Row[] = [];
    const shell = {
      toolCallId,
      toolName: name,
      rendererState: {},
      selfRenderHeight: 8,
      handleMouse() {},
      invalidate: () => {
        parts = build();
      },
      render: (w: number) => parts.flatMap((part) => part.render(w)),
      /** A click on the heading: it opens the block, or closes it when open. */
      click: () => parts[0]!.handleMouse?.(click()),
    };
    parts = build();
    children.push(shell);
    return shell;
  };
  /** A settled thought: pi's assistant message, rendering its thinking label as its only content. */
  const think = (thinking: string) => {
    const region = { child: { setText: () => {} } as unknown as Row, onMouse: () => undefined };
    const assistant = {
      contentContainer: { children: [region] },
      thinkingVisibilityOverrides: new Map<number, boolean>(),
      hideThinkingBlock: true,
      hiddenThinkingLabel: "Thinking...",
      isStreaming: false,
      lastMessage: { role: "assistant", content: [{ type: "thinking", thinking }] },
      updateContent() {},
      invalidate: () => {},
      render: (w: number) => region.child.render(w),
    };
    children.push(assistant);
    return assistant;
  };
  const close = () => {
    dispatch("session_shutdown", "");
    jest.useRealTimers();
  };
  return { add, think, dispatch, close, children, start };
}

/** Rows each block shows, blank ones aside: what the screen shows of the transcript. */
const heights = (children: object[]) =>
  children.map((child) => (child as Row).render(80).filter((row) => stripTerminalSequences(row).trim() !== "").length);

/**
 * Advance the clock in 5 ms frames, painting every block each frame as the screen does, and record
 * each frame that changed a row count: when, and by how much per block. `faded` notes a faded colour.
 */
function trace(children: object[], ms = 5000) {
  const changes: Array<{ at: number; diff: number[] }> = [];
  let last = heights(children);
  let faded = false;
  for (let at = 5; at <= ms; at += 5) {
    jest.advanceTimersByTime(5);
    const next = heights(children);
    faded ||= children.some((child) => (child as Row).render(80).join("").includes("38;2;"));
    const diff = next.map((rows, index) => rows - (last[index] ?? 0));
    if (diff.some(Boolean)) changes.push({ at, diff });
    last = next;
  }
  const gaps = changes.slice(1).map((change, index) => change.at - changes[index]!.at);
  return { changes, gaps, faded };
}

/** Each change takes exactly one row from exactly one block. */
const oneRowEach = (changes: Array<{ diff: number[] }>) =>
  changes.every((change) => change.diff.filter(Boolean).length === 1 && change.diff.some((rows) => rows === -1));

const longThought = Array.from({ length: 40 }, (_, index) => `thought line ${index + 1}`).join("\n");

/** An assistant message with prose only: a block that keeps its own row and splits the run. */
const prose = () => ({
  updateContent() {},
  contentContainer: { children: [] },
  thinkingVisibilityOverrides: new Map(),
  lastMessage: { content: [{ type: "text", text: "note" }] },
  invalidate() {},
  render: () => ["note"],
});

/** A user message: it ends the run. */
const user = () => ({ text: "next", markdownTheme: {}, render: () => ["next"] });

/** One step of newer blocks arriving together: every older block's distance grows by a whole level. */
function addStep(session: ReturnType<typeof fadeSession>, id: string) {
  return Array.from({ length: BLOCKS_PER_STEP }, (_, index) => session.add(index ? `${id}.${index}` : id));
}

/** The blocks that bring a forming group to five folded rows; the next one makes the sixth. */
const COLLAPSE_BLOCKS = FOLD_DISTANCE + FORMING_ROWS;

/** Five folded rows in a forming group, then the sixth block joins and the collapse begins. */
function collapseStart(session: ReturnType<typeof fadeSession>) {
  const shells = Array.from({ length: COLLAPSE_BLOCKS }, (_, index) => {
    const shell = session.add("collapse-" + index);
    session.dispatch("agent_settled");
    jest.advanceTimersByTime(10_000);
    return shell;
  });
  expect(toolPlan("collapse-0")?.group).toMatchObject({ forming: true });
  expect(toolPlan("collapse-0")?.group?.members).toHaveLength(FORMING_ROWS);
  const rows = () => shells.slice(0, FORMING_ROWS + 1).map((shell) => shell.render(80).length);
  expect(rows()).toEqual([2, 1, 1, 1, 1, 5]);
  // The sixth block folds through its heading, then the group collapses.
  session.add("collapse-" + COLLAPSE_BLOCKS);
  session.dispatch("agent_settled");
  for (let tick = 0; tick < 600 && toolPlan("collapse-" + FORMING_ROWS)?.mode === "normal"; tick++) {
    jest.advanceTimersByTime(10);
  }
  return { shells, rows };
}

/** The rows a hurried collapse shows from here until it closes, one state per change. */
function closing(rows: () => number[]): number[][] {
  const states: number[][] = [];
  let last = rows();
  for (let tick = 0; tick < 500 && last[0] !== 1; tick++) {
    jest.advanceTimersByTime(5);
    const next = rows();
    if (next.join() !== last.join()) states.push(next);
    last = next;
  }
  return states;
}

/** Blocks ten seconds apart are a slow session: a departing row fades over 480 ms, 120 ms a frame. */
const SLOW_ROW_MS = 480;

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

  test("hovering a block that can open fills the part of its bar its preview hides", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {} };
    tool.renderCall(ctx.args, barred, context);
    const body = tool.renderResult(result, {}, barred, context);
    const idle = body.render(80);
    expect(idle.some((row) => row.includes("48;5;"))).toBe(false);
    body.handleMouse?.({ ...move(), y: 1 });
    const hovered = body.render(80);
    // Seven of 40 lines shown, all at the end: each cell stands for five lines, so the six cells above
    // the shown lines fill with what a click would reveal.
    expect(hovered.map(barCell)).toEqual(["fill", "fill", "fill", "fill", "fill", "fill", "track", "track"]);
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
    const cut = preview.findIndex((line) => line.includes("⋮ 33 more lines"));
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

  test("hovering a block that can open lights its notice's words, without a background", () => {
    const tokens = { ...barred, fg: (token: string, text: string) => `<${token}>${text}</${token}>` };
    const tool = resolver()("bash", () => undefined) as Renderers;
    const context = { ...ctx, state: {} };
    tool.renderCall(ctx.args, tokens, context);
    const body = tool.renderResult(result, {}, tokens, context);
    const notice = () => body.render(80).find((line) => line.includes("more lines")) ?? "";
    expect(notice()).toContain("<thinkingOff>");
    body.handleMouse?.(move());
    expect(notice()).toContain("<text>");
    expect(notice()).not.toContain("<thinkingOff>");
    expect(backgrounds(notice()).filter((cell, column) => column !== 1 && cell !== undefined)).toEqual([]);
    // Opened, the whole output shows: there is no notice left to light.
    body.handleMouse?.(click());
    expect(body.render(80).some((line) => line.includes("more lines"))).toBe(false);
  });

  test("hovering a block that can open lights its clipped title, without a background", () => {
    // The `text` colour shows as upper case.
    const tokens = { ...barred, fg: (token: string, text: string) => (token === "text" ? text.toUpperCase() : text) };
    const tool = resolver()("bash", () => undefined) as Renderers;
    const command = "printf 'Edits: 5' > ./tmp/one.txt; for file in a b c; do echo $file; done";
    const context = { ...ctx, args: { command }, state: {} };
    const header = tool.renderCall(context.args, tokens, context);
    tool.renderResult({ content: [{ type: "text", text: "(no output)" }] }, {}, tokens, context);
    expect(header.render(50)[0]).toContain("printf");
    header.handleMouse?.(move());
    expect(header.render(50)[0]).toContain("PRINTF");
    expect(header.render(50)[0]).toContain(" … ");
    // A title shown whole does not change.
    expect(header.render(200)[0]).toContain(command);
  });

  test("a one-cell hover bar carries no position, so it lights in the hovered colours", () => {
    const accented = { ...barred, colors: { ...barred.colors, accent: "7" } };
    const tool = resolver()("bash", () => undefined) as Renderers;
    const command = "printf 'Edits: 5' > ./tmp/one.txt; for file in a b c; do echo $file > $file; done";
    const context = { ...ctx, args: { command }, state: {} };
    const header = tool.renderCall(context.args, accented, context);
    const body = tool.renderResult({ content: [{ type: "text", text: "(no output)" }] }, {}, accented, context);
    header.render(50);
    body.handleMouse?.(move());
    const rows = body.render(50);
    expect(rows).toHaveLength(1);
    // `accent` (7) on the bar cell, not the idle track grey (2).
    expect(backgrounds(rows[0]!)[1]).toBe("7");
  });

  test("a shell result's recorded file changes show under its output, and survive a reload", () => {
    const patch = "--- tmp/one.txt\n+++ tmp/one.txt\n@@ -0,0 +1,1 @@\n+Edits: 5\n";
    const details = { prismChanges: { files: [{ path: "tmp/one.txt", kind: "created", patch }] } };
    const silent = { content: [{ type: "text", text: "(no output)" }], details };
    // A reload renders the persisted result: the same details, a fresh renderer.
    for (const tool of [resolver(), resolver()].map((r) => r("bash", () => undefined) as Renderers)) {
      const context = { ...ctx, args: { command: "printf 'Edits: 5' > ./tmp/one.txt" }, state: {} };
      tool.renderCall(context.args, theme, context);
      const rows = tool
        .renderResult(silent, {}, theme, context)
        .render(60)
        .map((row) => row.trimEnd());
      expect(rows).toEqual(["    (no output)", "    tmp/one.txt", "    1  +Edits: 5"]);
    }
  });

  test("a read whose path the header cuts opens to show the whole path", () => {
    const tool = resolver()("read", () => undefined) as Renderers;
    const path = "packages/pi-prism/extensions/some/deeply/nested/folder/thinking.ts";
    const context = { ...ctx, args: { path }, state: {} };
    const header = tool.renderCall(context.args, theme, context);
    const body = tool.renderResult({ content: [{ type: "text", text: "one" }] }, {}, theme, context);
    expect(header.render(50)[0]).toContain(" … ");
    body.render(50);
    header.handleMouse?.(click());
    const opened = [...header.render(50), ...body.render(50)];
    expect(opened[0]).not.toContain("…");
    expect(opened.map((row) => row.trim()).join("")).toContain("deeply/nested/folder/thinking.ts");
  });

  test("hovering a clipped silent command marks its header, the only row it has", () => {
    const tool = resolver()("bash", () => undefined) as Renderers;
    const command = "echo " + "abcdefghij".repeat(12);
    const context = { ...ctx, args: { command }, state: {} };
    const header = tool.renderCall(context.args, barred, context);
    const body = tool.renderResult({ content: [] }, {}, barred, context);
    expect(header.render(40).map(barCell)).toEqual(["none"]);
    header.handleMouse?.(move());
    expect(header.render(40).map(markCell)).toEqual(["marker"]);
    expect(body.render(40)).toEqual([]);
    // Open, the full command is the body; the header takes no cell.
    header.handleMouse?.(click());
    expect(header.render(40).map(barCell)).toEqual(["none"]);
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
    // The header carries the command's first segment; the rest continues under its first column.
    expect(header.render(40)[0]).toStartWith("● bash · echo ·");
    const rows = body.render(40);
    expect(rows.every((row) => row.startsWith("         ") && row[9] !== " ")).toBe(true);
    expect(
      rows
        .slice(0, -1)
        .map((row) => row.slice(9))
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

  test("a read shown whole beside pi's note on the rest of the file stays inert", () => {
    const renderers = resolver()("read", () => undefined) as Renderers;
    const args = { path: "notes.txt", limit: 3 };
    const context = { ...ctx, args, state: {} };
    renderers.renderCall(args, barred, context);
    const text = "one\ntwo\nthree\n\n[121 more lines in file. Use offset=4 to continue.]";
    const body = renderers.renderResult({ content: [{ type: "text", text }] }, {}, barred, context);
    const idle = body.render(80);
    expect(idle.map(stripTerminalSequences).at(-1)?.trim()).toBe("↓  121 more lines in file");
    body.handleMouse?.({ ...move(), y: 1 });
    expect(hasBar(body.render(80))).toBe(false);
    body.handleMouse?.({ ...click(), y: 1 });
    expect(body.render(80)).toEqual(idle);
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
    // pi's display diff numbers its lines; the number moves to the gutter in front of the sign.
    expect(body.render(80).map((line) => line.trimEnd())).toEqual(["    1  -before", "    1  +after"]);
    expect(tool.renderResult({ content }, {}, theme, context).render(80)[0]).toContain("Successfully replaced");
  });

  test("visible tools paint successive fade frames before shrinking and before entering a group", () => {
    const session = fadeSession("bash");
    try {
      const oldest = session.add("animated-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      // Blocks ten seconds apart are a slow session: a row fades over 480 ms, 120 ms a frame.
      for (let i = 1; i <= 5; i++) {
        // A step takes BLOCKS_PER_STEP newer blocks: the ones before its last leave the block as it is.
        for (let within = 1; within < BLOCKS_PER_STEP; within++) {
          const level = toolPlan(oldest.toolCallId)?.level;
          const still = oldest.render(80);
          session.add(`animated-${i}.${within}`);
          session.dispatch("agent_settled");
          for (let frame = 0; frame < 4; frame++) {
            jest.advanceTimersByTime(120);
            expect(oldest.render(80)).toEqual(still);
          }
          expect(still.join("")).not.toContain("38;2;");
          expect(toolPlan(oldest.toolCallId)?.level).toBe(level!);
          jest.advanceTimersByTime(10000);
        }
        session.add("animated-" + i);
        session.dispatch("agent_settled");
        const first = oldest.render(80);
        jest.advanceTimersByTime(120);
        const second = oldest.render(80);
        expect(second.map(stripTerminalSequences)).toEqual(first.map(stripTerminalSequences));
        expect(second.filter((line, index) => line !== first[index])).toHaveLength(1);
        expect(second.join("")).toContain("38;2;140;140;140");
        if (i === 5) {
          jest.advanceTimersByTime(360);
          // It starts a new, forming group: the body folds and the heading stays as the member row.
          for (let height = first.length - 1; height > 1; height--) {
            expect(oldest.render(80).map(stripTerminalSequences)).toEqual(
              first.slice(0, height).map(stripTerminalSequences),
            );
            jest.advanceTimersByTime(480);
          }
          const grouped = oldest.render(80).map(stripTerminalSequences);
          expect(grouped[0]).toStartWith("▾ Ran 1 shell command");
          expect(grouped[1]).toStartWith("  ● bash · bun test");
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
        for (let within = 1; within < BLOCKS_PER_STEP; within++) {
          session.add(`read-${step}.${within}`);
          session.dispatch("agent_settled");
          jest.advanceTimersByTime(10000);
        }
        session.add("read-" + step);
        session.dispatch("agent_settled");
        const first = oldest.render(80);
        // One frame: 90 ms before any gap is known, 120 ms once blocks arrive ten seconds apart.
        jest.advanceTimersByTime(120);
        const fading = oldest.render(80).filter((line, index) => line !== first[index]);
        expect(fading).toHaveLength(1);
        const line = stripTerminalSequences(fading[0]!).trim();
        expect(line).toMatch(/^\d+  line \d+$/);
        jest.advanceTimersByTime(10000);
        expect(oldest.render(80).map((row) => stripTerminalSequences(row).trim())).not.toContain(line);
      }
    } finally {
      session.close();
    }
  });

  test("a block joining a forming group folds its body and keeps its heading as the member row", () => {
    const session = fadeSession("bash");
    try {
      const shells = Array.from({ length: FOLD_DISTANCE + 2 }, (_, index) => {
        const shell = session.add("join-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
        return shell;
      });
      expect(toolPlan("join-0")?.group).toMatchObject({ forming: true });
      expect(toolPlan("join-0")?.group?.members).toHaveLength(2);
      const joiner = shells[2]!;
      const heading = joiner.render(80)[0];
      session.add("join-" + (FOLD_DISTANCE + 2));
      session.dispatch("agent_settled");
      for (let tick = 0; tick < 40 && toolPlan("join-2")?.mode === "normal"; tick++) {
        expect(joiner.render(80)[0]).toBe(heading);
        jest.advanceTimersByTime(90);
      }
      expect(toolPlan("join-0")?.group?.members).toHaveLength(3);
      const member = joiner.render(80).map(stripTerminalSequences);
      expect(member).toHaveLength(1);
      expect(member[0]).toMatch(/^ {2}● bash · bun test/);
    } finally {
      session.close();
    }
  });

  test("structural events without a new block leave the collapse one row per fade", () => {
    const session = fadeSession("bash");
    try {
      const { rows } = collapseStart(session);
      jest.advanceTimersByTime(SLOW_ROW_MS / 2);
      session.dispatch("turn_end");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(SLOW_ROW_MS / 2);
      expect(rows()).toEqual([2, 1, 1, 1, 0, 0]);
      jest.advanceTimersByTime(SLOW_ROW_MS);
      expect(rows()).toEqual([2, 1, 1, 0, 0, 0]);
    } finally {
      session.close();
    }
  });

  test("new blocks mid-collapse let the fading row finish, then the rest leave one row at a time", () => {
    const session = fadeSession("bash");
    try {
      const { rows } = collapseStart(session);
      jest.advanceTimersByTime(SLOW_ROW_MS / 2);
      session.add("collapse-" + (COLLAPSE_BLOCKS + 1));
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(SLOW_ROW_MS / 2 - 20);
      expect(rows()).toEqual([2, 1, 1, 1, 1, 0]);
      jest.advanceTimersByTime(20);
      expect(rows()).toEqual([2, 1, 1, 1, 0, 0]);
      expect(closing(rows)).toEqual([
        [2, 1, 1, 0, 0, 0],
        [2, 1, 0, 0, 0, 0],
        [2, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0],
      ]);
      expect(toolPlan("collapse-0")?.group?.open).toBe(false);
    } finally {
      session.close();
    }
  });

  test("a collapsing group rebuilt mid-row hands its collapse on: the row finishes, then the rest leave one at a time", () => {
    const session = fadeSession("bash");
    try {
      const { shells, rows } = collapseStart(session);
      jest.advanceTimersByTime(SLOW_ROW_MS / 2);
      expect(rows()).toEqual([2, 1, 1, 1, 1, 0]);
      // A member's result lands late: its timing changes, so the planner builds a new group object.
      const group = toolPlan("collapse-0")!.group!;
      (shells[2] as { result?: { timestamp: number } }).result = { timestamp: 5 };
      session.dispatch("agent_settled");
      expect(toolPlan("collapse-0")!.group).not.toBe(group);
      expect(rows()).toEqual([2, 1, 1, 1, 1, 0]);
      jest.advanceTimersByTime(SLOW_ROW_MS / 2 + 20);
      expect(rows()).toEqual([2, 1, 1, 1, 0, 0]);
      expect(closing(rows).at(-1)).toEqual([1, 0, 0, 0, 0, 0]);
    } finally {
      session.close();
    }
  });

  test("a forming group that stops forming offscreen collapses at once", () => {
    // Twenty rows show only the newest blocks; the forming group and its sixth block sit above them.
    const session = fadeSession("bash", output, undefined, 20);
    try {
      const { rows } = collapseStart(session);
      expect(rows()).toEqual([1, 0, 0, 0, 0, 0]);
      expect(toolPlan("collapse-0")?.group).toMatchObject({ forming: false, open: false });
    } finally {
      session.close();
    }
  });

  test("opening a member mid-collapse stops the collapse; closing and reopening the group lists every member", () => {
    const session = fadeSession("bash");
    try {
      const { rows } = collapseStart(session);
      jest.advanceTimersByTime(SLOW_ROW_MS + 40);
      expect(rows()).toEqual([2, 1, 1, 1, 0, 0]);
      // What a click that opens a member does to its group.
      keepGroupOpen(toolPlan("collapse-0")!.group!);
      expect(rows()).toEqual([2, 1, 1, 1, 1, 1]);
      jest.advanceTimersByTime(3000);
      expect(rows()).toEqual([2, 1, 1, 1, 1, 1]);
      setGroupOpen(toolPlan("collapse-0")!.group!, false);
      session.dispatch("agent_settled");
      expect(rows()).toEqual([1, 0, 0, 0, 0, 0]);
      setGroupOpen(toolPlan("collapse-0")!.group!, true);
      session.dispatch("agent_settled");
      expect(rows()).toEqual([2, 1, 1, 1, 1, 1]);
      // The blocks that waited behind the collapse take their turn.
      jest.advanceTimersByTime(3000);
      const waited = Array.from({ length: FOLD_DISTANCE - 1 }, (_, index) => FORMING_ROWS + 1 + index);
      expect(waited.map((index) => toolPlan("collapse-" + index)?.level)).toEqual(
        waited.map((index) => detailFor(COLLAPSE_BLOCKS - index)),
      );
    } finally {
      session.close();
    }
  });

  test("a forming group that reaches six rows collapses one row per fade, bottom to top", () => {
    const session = fadeSession("bash");
    try {
      const { shells, rows } = collapseStart(session);
      expect(rows()).toEqual([2, 1, 1, 1, 1, 0]);
      jest.advanceTimersByTime(SLOW_ROW_MS / 4);
      // The bottom member row fades over a whole fade before it leaves.
      expect(rows()).toEqual([2, 1, 1, 1, 1, 0]);
      expect(stripTerminalSequences(shells[4]!.render(80)[0]!)).toContain("bun test");
      expect(shells[4]!.render(80)[0]).toContain("38;2;140;140;140");
      jest.advanceTimersByTime((SLOW_ROW_MS * 3) / 4);
      expect(rows()).toEqual([2, 1, 1, 1, 0, 0]);
      jest.advanceTimersByTime(SLOW_ROW_MS);
      expect(rows()).toEqual([2, 1, 1, 0, 0, 0]);
      jest.advanceTimersByTime(2 * SLOW_ROW_MS);
      expect(rows()).toEqual([2, 0, 0, 0, 0, 0]);
      jest.advanceTimersByTime(SLOW_ROW_MS);
      expect(rows()).toEqual([1, 0, 0, 0, 0, 0]);
      expect(toolPlan("collapse-0")?.group).toMatchObject({ forming: false, open: false });
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
      // The new rows' registration schedules the walk that starts the fade.
      addStep(session, "walk-1");
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

  test("a transcript rebuilt mid-fade leaves no frame behind for the new rows", () => {
    const session = fadeSession("bash");
    try {
      session.add("rebuilt-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      addStep(session, "rebuilt-1");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(90);
      expect(toolFade("rebuilt-0")).toBeDefined();
      // pi clears the chat and renders every entry again (compaction, tree navigation, settings).
      session.children.length = 0;
      const again = session.add("rebuilt-0");
      addStep(session, "rebuilt-1");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(10_000);
      expect(toolFade("rebuilt-0")).toBeUndefined();
      // No row keeps the faded colour.
      expect(again.render(80).join("")).not.toContain("38;2;");
    } finally {
      session.close();
    }
  });

  test("shutting the session down cancels a queued walk and starts no fade", () => {
    const session = fadeSession("bash");
    try {
      session.add("shut-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      // Registering the new row queues a walk on a 0 ms timer.
      addStep(session, "shut-1");
      session.dispatch("session_shutdown", "");
      jest.advanceTimersByTime(1);
      expect(toolFade("shut-0")).toBeUndefined();
      // Only the probe widget's removal was still pending: no fade timer runs on the dead session.
      jest.advanceTimersByTime(1000);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      session.close();
    }
  });

  test("a session started after a shutdown probes the TUI again and plans its blocks", () => {
    const session = fadeSession("bash");
    try {
      session.add("first-life-0");
      session.dispatch("agent_settled");
      session.dispatch("session_shutdown", "");
      // /new, resume and fork: pi shuts the session down, then starts the next one in the same process.
      session.children.length = 0;
      session.start();
      jest.advanceTimersByTime(1);
      session.add("next-life-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      addStep(session, "next-life-1");
      session.dispatch("agent_settled");
      expect(toolFade("next-life-0")).toBeDefined();
      jest.advanceTimersByTime(10_000);
      expect(toolPlan("next-life-0")?.level).toBe(1);
    } finally {
      session.close();
    }
  });

  test("a newer block never folds past an older block that is still on its way", () => {
    for (const settled of [FOLD_DISTANCE + 3, FOLD_DISTANCE + FORMING_ROWS]) {
      const session = fadeSession("bash");
      try {
        const ids = Array.from({ length: settled + 2 }, (_, index) => `pass-${settled}-${index}`);
        const shells = ids.slice(0, settled).map((id) => {
          const shell = session.add(id);
          session.dispatch("agent_settled");
          jest.advanceTimersByTime(10_000);
          return shell;
        });
        // The oldest standalone block starts folding, then one more block arrives mid-fold.
        const joiner = shells[settled - FOLD_DISTANCE]!;
        shells.push(session.add(ids[settled]!));
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(180);
        // A whole step: a block already held one level back lands two levels behind and must wait.
        shells.push(...addStep(session, ids[settled + 1]!));
        session.dispatch("agent_settled");
        let joinerRows = joiner.render(80).length;
        let groupRows = shells[0]!.render(80).length;
        let shrank = false;
        for (let tick = 0; tick < 80; tick++) {
          const modes = ids.map((id) => toolPlan(id)?.mode);
          // Grouped blocks stay above standalone ones: no newer block joins a group ahead of an older one.
          expect(modes.slice(modes.indexOf("normal")).every((mode) => mode === "normal")).toBe(true);
          const rows = joiner.render(80).length;
          expect(rows).toBeLessThanOrEqual(joinerRows);
          joinerRows = rows;
          // The forming group grows; it never collapses and then forms again.
          const anchorRows = shells[0]!.render(80).length;
          if (anchorRows < groupRows) shrank = true;
          if (shrank) expect(anchorRows).toBeLessThanOrEqual(groupRows);
          groupRows = anchorRows;
          jest.advanceTimersByTime(90);
        }
      } finally {
        session.close();
      }
    }
  });

  test("blocks held back behind a folding block follow it one row at a time, without a fade", () => {
    const session = fadeSession("bash");
    try {
      const shells = Array.from({ length: FOLD_DISTANCE + 1 }, (_, index) => {
        const shell = session.add("held-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
        return shell;
      });
      // A user message ends the run: every block heads for the group. held-1 up to held-BLOCKS_PER_STEP share
      // the last standalone level, one step away: they fold first. The others are further behind and wait.
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      let landed = false;
      for (let tick = 0; tick < 1500 && !landed; tick++) {
        jest.advanceTimersByTime(10);
        landed = toolPlan("held-" + BLOCKS_PER_STEP)?.mode !== "normal";
        if (landed) break;
        for (const shell of shells.slice(BLOCKS_PER_STEP + 1)) {
          expect(toolPlan(shell.toolCallId)?.mode).toBe("normal");
          expect(shell.render(80).join("")).not.toContain("38;2;");
        }
      }
      expect(landed).toBe(true);
      // The next block does not join at once: it loses its rows one at a time, then the next one does.
      expect(toolPlan("held-" + (BLOCKS_PER_STEP + 1))?.mode).toBe("normal");
      const { changes, faded } = trace(session.children);
      expect(faded).toBe(false);
      expect(oneRowEach(changes)).toBe(true);
      expect(shells.map((shell) => toolPlan(shell.toolCallId)?.mode)).toEqual(
        shells.map((_, index) => (index ? "hidden" : "anchor")),
      );
    } finally {
      session.close();
    }
  });

  test("blocks arriving together that take a block past its last standalone level fold it instead of stepping", () => {
    const session = fadeSession("bash");
    try {
      const oldest = session.add("pair-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(10_000);
      for (let index = 1; index <= FOLD_DISTANCE - BLOCKS_PER_STEP; index++) {
        session.add("pair-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
      }
      // The first distance of the last standalone level: a whole step from the fold.
      expect(toolPlan("pair-0")).toMatchObject({ mode: "normal", level: detailFor(FOLD_DISTANCE - 1) });
      const before = oldest.render(80).map(stripTerminalSequences);
      addStep(session, "pair-late");
      session.dispatch("agent_settled");
      // A fold, not a step fade: the body leaves from the bottom, one row per fade.
      expect(toolFade("pair-0")).toBeUndefined();
      // The screen repaints every frame; a fold counts its rows as it paints them.
      const frames = (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 60) {
          oldest.render(80);
          jest.advanceTimersByTime(60);
        }
      };
      frames(SLOW_ROW_MS);
      expect(oldest.render(80).map(stripTerminalSequences)).toEqual(before.slice(0, -1));
      expect(toolPlan("pair-0")?.mode).toBe("normal");
      frames(10 * SLOW_ROW_MS);
      expect(toolPlan("pair-0")?.mode).toBe("anchor");
      expect(oldest.render(80).map(stripTerminalSequences)[1]).toStartWith("  ● bash · bun test");
    } finally {
      session.close();
    }
  });

  test("a collapse that starts while another runs waits for it, and both groups close", () => {
    const session = fadeSession("bash");
    try {
      const shells: Array<ReturnType<typeof session.add>> = [];
      const add = (id: string) => {
        shells.push(session.add(id));
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
      };
      for (let index = 0; index < 3; index++) add("first-" + index);
      session.children.push(prose());
      session.dispatch("agent_settled");
      for (let index = 0; index < FOLD_DISTANCE; index++) add("second-" + index);
      // One more block makes the second group form, so the first stops forming and collapses.
      shells.push(session.add("second-" + FOLD_DISTANCE));
      session.dispatch("agent_settled");
      for (let tick = 0; tick < 40 && toolPlan("second-0")?.mode === "normal"; tick++) jest.advanceTimersByTime(90);
      jest.advanceTimersByTime(SLOW_ROW_MS + 40);
      const first = () => shells.slice(0, 3).map((shell) => shell.render(80).length);
      expect(first()).toEqual([2, 1, 0]);
      // A user message ends the second group's forming mid-collapse of the first.
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      jest.advanceTimersByTime(10_000);
      session.dispatch("agent_settled");
      expect(first()).toEqual([1, 0, 0]);
      expect(toolPlan("first-0")?.group?.open).toBe(false);
      expect(shells[3]!.render(80)).toHaveLength(1);
      expect(toolPlan("second-0")?.group?.open).toBe(false);
      setGroupOpen(toolPlan("first-0")!.group!, true);
      session.dispatch("agent_settled");
      expect(first()).toEqual([2, 1, 1]);
    } finally {
      session.close();
    }
  });

  test("an open group's members line up in columns, thoughts and tools alike", () => {
    const session = fadeSession("bash");
    try {
      const region = { child: { setText: () => {} } as unknown as Row, onMouse: () => undefined };
      const message = { role: "assistant", content: [{ type: "thinking", thinking: "weigh the options" }] };
      const thought = {
        contentContainer: { children: [region] },
        thinkingVisibilityOverrides: new Map<number, boolean>(),
        hideThinkingBlock: true,
        hiddenThinkingLabel: "Thinking...",
        isStreaming: false,
        lastMessage: message,
        updateContent() {},
        invalidate: () => {},
        render: () => [],
      };
      session.children.push(thought);
      const shells = Array.from({ length: FOLD_DISTANCE + 2 }, (_, index) => {
        const shell = session.add("table-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
        return shell;
      });
      // The thought and the two oldest commands form the newest group, listed under its summary.
      expect(toolPlan("table-0")?.group?.members.map((member) => member.kind)).toEqual(["thinking", "tool", "tool"]);
      const rows = [region.child.render(80)[1]!, shells[0]!.render(80)[0]!, shells[1]!.render(80)[0]!];
      expect(rows[0]).toMatch(/^ {2}✻ think · weigh the options/);
      expect(rows[1]).toMatch(/^ {2}● bash {2}· bun test/);
      expect(new Set(rows.map((row) => row.indexOf(" · ")))).toEqual(new Set([rows[0]!.indexOf(" · ")]));
      // The numbers line up too; the thought's tokens are model output, its input column stays blank.
      expect(new Set(rows.map((row) => row.indexOf("out ")))).toEqual(new Set([rows[0]!.indexOf("out ")]));
      expect(rows[1]!.indexOf("· in ")).toBe(rows[2]!.indexOf("· in "));
      expect(rows[0]).not.toContain(" in ");
      expect(new Set(rows.map((row) => row.length))).toEqual(new Set([80]));
    } finally {
      session.close();
    }
  });

  test("blocks more than one step behind catch up one row at a time, without fade frames", () => {
    const session = fadeSession("bash");
    try {
      session.add("burst-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      // Four steps of new blocks inside one fade, a block every 21 ms.
      const count = 4 * BLOCKS_PER_STEP;
      for (let index = 1; index <= count; index++) {
        session.add("burst-" + index);
        jest.advanceTimersByTime(1);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(20);
      }
      // The fading block finishes its row; then every block still behind loses one row per interval.
      const { changes } = trace(session.children);
      expect(oneRowEach(changes)).toBe(true);
      const all = Array.from({ length: count + 1 }, (_, index) => index);
      expect(all.map((index) => toolPlan("burst-" + index)?.level)).toEqual(
        all.map((index) => detailFor(count - index)),
      );
    } finally {
      session.close();
    }
  });

  test("a user message takes the finished run away one row at a time, oldest block first, thoughts and the forming group included", () => {
    const session = fadeSession("bash");
    try {
      // FOLD_DISTANCE + 3 blocks: the oldest three form the run's group, a thought sits among the previews.
      const blocks = FOLD_DISTANCE + 3;
      for (let index = 0; index < blocks; index++) {
        if (index === 6) session.think(longThought);
        else session.add("run-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
      }
      expect(toolPlan("run-0")?.group).toMatchObject({ forming: true, open: true });
      expect(heights(session.children)).toEqual([2, 1, 1, 5, 5, 6, 5, 7, 7, 8, 8, 9, 9]);
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      session.dispatch("agent_settled");
      const { changes, gaps, faded } = trace(session.children);
      // No fade frames: each row simply leaves, one at a time, never two at once.
      expect(faded).toBe(false);
      expect(oneRowEach(changes)).toBe(true);
      // Oldest first: the group (its three rows are one block) lists fewer members, then each block folds in turn.
      const order = changes.map((change) => Math.max(0, change.diff.findIndex(Boolean) - 2));
      expect(order).toEqual(order.toSorted((a, b) => a - b));
      expect(new Set(order).size).toBe(blocks - 2);
      // A big backlog runs at the floor.
      expect(changes[0]!.at).toBe(BACKLOG_MIN_MS);
      expect(new Set(gaps)).toEqual(new Set([BACKLOG_MIN_MS]));
      // It lands where the instant catch-up did: one closed group of every block of the run.
      expect(heights(session.children)).toEqual([1, ...Array.from({ length: blocks - 1 }, () => 0), 1]);
      expect(toolPlan("run-0")?.group).toMatchObject({ open: false });
      expect(toolPlan("run-0")?.group?.members).toHaveLength(blocks);
      expect(stripTerminalSequences((session.children[0] as Row).render(80)[0]!)).toMatch(
        new RegExp(`^▸ Ran ${blocks - 1} shell commands for \\d+ms, thought 1 time `),
      );
    } finally {
      session.close();
    }
  });

  test("a backlog's interval follows its rows: the floor for a big one, one fade at most for a small one", () => {
    const session = fadeSession("bash");
    try {
      // Two blocks ten seconds apart, then three at once: the pace is ten seconds, a fade 480 ms.
      session.add("small-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(10_000);
      session.add("small-1");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(10_000);
      for (let index = 2; index < 5; index++) session.add("small-" + index);
      session.dispatch("agent_settled");
      // small-0 is two levels behind, small-1 one: three rows, so 500 ms a row, capped at one fade.
      const { changes, gaps } = trace(session.children);
      expect(changes).toHaveLength(3);
      expect(oneRowEach(changes)).toBe(true);
      expect(backlogIntervalMs(3, 10_000)).toBe(fadeDurationMs(10_000));
      expect([changes[0]!.at, ...gaps]).toEqual([480, 480, 480]);
      expect(["small-0", "small-1"].map((id) => toolPlan(id)?.level)).toEqual([2, 1]);
    } finally {
      session.close();
    }
  });

  test("new blocks mid-backlog extend it, and every block still lands where the plan puts it", () => {
    const session = fadeSession("bash");
    try {
      for (let index = 0; index < 3; index++) {
        session.add("extend-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
      }
      // Two steps at once: every block is two levels behind, six rows at 250 ms each.
      for (let index = 3; index < 7; index++) session.add("extend-" + index);
      session.dispatch("agent_settled");
      let { changes } = trace(session.children, 600);
      expect(changes.map((change) => change.at)).toEqual([250, 500]);
      // One more step arrives mid-backlog: the rows it adds spread over what is left.
      for (let index = 7; index < 9; index++) session.add("extend-" + index);
      session.dispatch("agent_settled");
      ({ changes } = trace(session.children));
      expect(oneRowEach(changes)).toBe(true);
      const all = Array.from({ length: 9 }, (_, index) => index);
      expect(all.map((index) => toolPlan("extend-" + index)?.level)).toEqual(all.map((index) => detailFor(8 - index)));
    } finally {
      session.close();
    }
  });

  test("a click mid-backlog pins its block open, and the backlog goes on around it", () => {
    const session = fadeSession("bash");
    try {
      const shells = Array.from({ length: FOLD_DISTANCE }, (_, index) => {
        const shell = session.add("pin-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
        return shell;
      });
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      session.dispatch("agent_settled");
      trace(session.children, 100);
      // The newest block still waits its turn: a click opens it, and it stays open.
      const newest = shells.at(-1)!;
      expect(toolPlan(newest.toolCallId)).toMatchObject({ mode: "normal", level: 0 });
      newest.click();
      const { changes } = trace(session.children);
      expect(oneRowEach(changes.filter((change) => !change.diff.at(-2)))).toBe(true);
      expect(newest.render(80)).toHaveLength(41);
      expect(toolPlan(newest.toolCallId)?.mode).toBe("normal");
      // Every other block of the run folded into the group above it.
      expect(toolPlan("pin-0")?.group?.members).toHaveLength(FOLD_DISTANCE - 1);
    } finally {
      session.close();
    }
  });

  test("offscreen blocks of a backlog change at once; the rows on screen leave one at a time", () => {
    // Twenty rows show only the newest blocks; the older ones sit above them.
    const session = fadeSession("bash", output, undefined, 20);
    try {
      const shells = Array.from({ length: FOLD_DISTANCE }, (_, index) => {
        const shell = session.add("screen-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
        return shell;
      });
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      // Before the first backlog row leaves, the offscreen blocks have folded and the visible ones wait.
      expect(toolPlan("screen-0")?.mode).toBe("anchor");
      expect(toolPlan("screen-4")?.mode).toBe("hidden");
      expect(shells.slice(-2).map((shell) => toolPlan(shell.toolCallId)?.mode)).toEqual(["normal", "normal"]);
      const { changes } = trace(session.children);
      expect(changes.length).toBeGreaterThan(5);
      expect(oneRowEach(changes)).toBe(true);
      expect(shells.map((shell) => toolPlan(shell.toolCallId)?.mode)).toEqual(
        shells.map((_, index) => (index ? "hidden" : "anchor")),
      );
    } finally {
      session.close();
    }
  });

  test("a backlog tick repaints one block: the transcript is walked once per block that lands", () => {
    let visits = 0;
    const session = fadeSession("bash", output, () => visits++);
    try {
      for (let index = 0; index < FOLD_DISTANCE; index++) {
        session.add("walk-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
      }
      // One walk of the transcript, as a structural event with nothing to change makes it.
      let before = visits;
      session.dispatch("agent_settled");
      const walk = visits - before;
      session.children.push(user());
      before = visits;
      session.dispatch("message_start", { message: { role: "user" } });
      const { changes } = trace(session.children);
      // Every block of the run lands once, and the message's own walk: far fewer walks than rows.
      expect(changes.length).toBeGreaterThan(3 * FOLD_DISTANCE);
      expect((visits - before) / walk).toBeLessThanOrEqual(FOLD_DISTANCE + 3);
    } finally {
      session.close();
    }
  });

  test("shutting the session down mid-backlog cancels its timer", () => {
    const session = fadeSession("bash");
    try {
      for (let index = 0; index < FOLD_DISTANCE; index++) {
        session.add("halt-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(10_000);
      }
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      session.dispatch("agent_settled");
      expect(trace(session.children, 100).changes.length).toBeGreaterThan(0);
      session.dispatch("session_shutdown", "");
      const rows = heights(session.children);
      jest.advanceTimersByTime(1000);
      expect(jest.getTimerCount()).toBe(0);
      expect(heights(session.children)).toEqual(rows);
    } finally {
      session.close();
    }
  });

  test("the gap between new blocks sets the fade, a burst counts once, and a user message resets it", () => {
    const session = fadeSession("read");
    try {
      // New blocks 800 ms apart: a row fades over 200 ms, neither the default 360 nor the 80 ms floor.
      for (let index = 0; index <= BLOCKS_PER_STEP; index++) {
        session.add("quick-" + index);
        session.dispatch("agent_settled");
        jest.advanceTimersByTime(800);
      }
      // A burst of two steps: the first starts the next fade, the second lands 1 ms later and counts with it.
      addStep(session, "quick-a");
      jest.advanceTimersByTime(1);
      addStep(session, "quick-b");
      session.dispatch("agent_settled");
      // The oldest block fades its row over 200 ms; the level the burst added leaves next, as a backlog row.
      jest.advanceTimersByTime(150);
      expect(toolPlan("quick-0")?.level).toBe(1);
      jest.advanceTimersByTime(60);
      expect(toolPlan("quick-0")?.level).toBe(2);
      jest.advanceTimersByTime(10_000);
      expect(toolPlan("quick-0")?.level).toBe(3);
      // A new run starts without a pace: the next fade takes the default 360 ms. The finished run's
      // blocks, older, leave first.
      session.children.push(user());
      session.dispatch("message_start", { message: { role: "user" } });
      jest.advanceTimersByTime(10_000);
      session.add("next-0");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(1);
      addStep(session, "next-1");
      session.dispatch("agent_settled");
      jest.advanceTimersByTime(300);
      expect(toolPlan("next-0")?.level).toBe(0);
      jest.advanceTimersByTime(70);
      expect(toolPlan("next-0")?.level).toBe(1);
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
      addStep(session, "short-1");
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

    for (let index = 0; index < BLOCKS_PER_STEP; index++) {
      children.push({ ...children[0]!, toolCallId: `newer-${index}` });
      tool.renderCall(ctx.args, theme, { ...ctx, toolCallId: `newer-${index}`, state: {} });
    }
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
    const headers = Array.from({ length: FOLD_DISTANCE + 2 }, (_, index) => add(index));
    await Bun.sleep(10);
    // A small group of the current run already lists its members.
    expect(toolPlan("growing-0")?.group?.forming).toBe(true);
    const member = headers[1]!;
    member().handleMouse?.(click());
    expect(member().render(80)).toHaveLength(41);
    add(FOLD_DISTANCE + 2);
    dispatch("turn_end");
    dispatch("turn_start");
    expect(member().render(80)).toHaveLength(41);
    expect(toolPlan("growing-0")?.group?.durationMs).toBe(700);
    member().handleMouse?.(click());
    expect(member().render(80)).toHaveLength(1);
  });

  test("a group marks its hovered summary and members on their marker glyph, and a click anywhere toggles them", async () => {
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
            factory?.(historyViewport(children), barred),
        },
      },
    );
    const add = (index: number) => {
      const toolCallId = `forming-${index}`;
      children.push({ toolCallId, toolName: "read", rendererState: {} });
      const context = { ...ctx, args: { path: `file-${index}` }, toolCallId, state: {}, durationMs: 500 };
      tool.renderResult(result, {}, barred, context);
      return () => tool.renderCall(context.args, barred, context);
    };
    const headers = Array.from({ length: FOLD_DISTANCE + 2 }, (_, index) => add(index));
    await Bun.sleep(10);
    const anchor = headers[0]!;
    const member = headers[1]!;
    expect(toolPlan("forming-0")?.group).toMatchObject({ forming: true, open: true });
    expect(anchor().render(80).map(barCell)).toEqual(["none", "none"]);

    // The summary: one filled cell in column 1, the row otherwise as rendered, and no chip.
    const idle = anchor().render(80)[0]!;
    anchor().handleMouse?.({ ...move(), y: 0 });
    const hovered = anchor().render(80);
    expect(hovered.map(markCell)).toEqual(["marker", "none"]);
    expect(stripTerminalSequences(hovered[0]!).trimEnd()).toBe(stripTerminalSequences(idle).trimEnd());
    expect(hovered.join("\n")).not.toContain("[ click");

    // A collapsed member that can open: one filled cell on its row, and the summary lets go.
    member().handleMouse?.({ ...move(), y: 0 });
    expect(member().render(80).map(markCell)).toEqual(["marker"]);
    expect(anchor().render(80).map(barCell)).toEqual(["none", "none"]);

    // Opening a member shows its body with no chip; inline mode has no open-block bar.
    member().handleMouse?.({ ...click(), x: 50 });
    const open = member().render(80);
    expect(open).toHaveLength(41);
    expect(open.map(barCell).every((cell) => cell === "none")).toBe(true);
    expect(open.join("\n")).not.toContain("[ click");
    // Any row of the open member closes it.
    member().handleMouse?.({ ...click(), y: 20 });
    expect(member().render(80)).toHaveLength(1);
    member().handleMouse?.({ ...click(), y: 0 });

    // Opening a member keeps the group open past six rows, with no pinned chip on its summary.
    for (let index = FOLD_DISTANCE + 2; index < FOLD_DISTANCE + 7; index++) add(index);
    dispatch("agent_settled");
    dispatch("agent_settled");
    expect(toolPlan("forming-0")?.group).toMatchObject({ forming: false, open: true });
    expect(anchor().render(80)[0]).not.toContain("[ click");

    // A click anywhere along the summary row closes the group, and the next opens it again.
    anchor().handleMouse?.({ ...click(), x: 70, y: 0 });
    expect(toolPlan("forming-0")?.group?.open).toBe(false);
    expect(anchor().render(80)).toHaveLength(1);
    expect(anchor().render(80).map(markCell)).toEqual(["marker"]);
    anchor().handleMouse?.({ ...click(), x: 3, y: 0 });
    expect(toolPlan("forming-0")?.group?.open).toBe(true);
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

/** A stand-in for pi's assistant message: one thinking run behind a MouseRegion whose click flips its visibility. */
function thoughtSession(text: string) {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  prism({
    registerToolRenderer: () => {},
    on: (event: string, handler: (...args: any[]) => void) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as never);
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: text }],
    timestamp: 1000,
    durationMs: 4000,
  };
  const overrides = new Map<number, boolean>();
  interface Region {
    child: Row;
    onMouse(event: { type?: string; y?: number }): unknown;
  }
  // Like pi, every content update builds a fresh label and region.
  const region = (): Region => ({
    child: { setText: () => {} } as unknown as Row,
    onMouse(event) {
      if (event.type !== "click") return undefined;
      overrides.set(0, !(overrides.get(0) ?? true));
      assistant.updateContent(message);
      return { handled: true, render: true };
    },
  });
  const assistant = {
    contentContainer: { children: [region()] },
    thinkingVisibilityOverrides: overrides,
    hideThinkingBlock: true,
    hiddenThinkingLabel: "Thinking...",
    isStreaming: false,
    lastMessage: message,
    updateContent(next: typeof message) {
      this.lastMessage = next;
      this.contentContainer.children = [region()];
    },
    invalidate: () => {},
  };
  const current = () => assistant.contentContainer.children[0]!;
  const root = { children: [assistant], requestRender: () => {} };
  for (const handler of handlers.get("session_start") ?? [])
    handler(
      {},
      {
        hasUI: true,
        mode: "tui",
        ui: { setWidget: (_: string, factory?: (tui: object, theme: object) => void) => factory?.(root, barred) },
      },
    );
  return {
    rows: (width = 80) => current().child.render(width),
    mouse: (type: "move" | "click", y: number) => current().onMouse({ type, y }),
  };
}

describe("thought interaction", () => {
  const long = Array.from({ length: 40 }, (_, index) => `thought line ${index + 1}`).join("\n");

  test("hovering a thought that can open paints only its preview bar in column 1", async () => {
    const thought = thoughtSession(long);
    await Bun.sleep(10);
    const idle = thought.rows();
    // The heading, six kept lines and the notice below them.
    expect(idle).toHaveLength(8);
    expect(idle.map(barCell).every((cell) => cell === "none")).toBe(true);
    thought.mouse("move", 3);
    const hovered = thought.rows();
    // Forty lines over seven cells; the last six are shown, so every cell above the bottom one fills.
    expect(hovered.map(barCell)).toEqual(["none", "fill", "fill", "fill", "fill", "fill", "fill", "track"]);
    expect(plainRows(hovered).map((row) => row.slice(0, 1) + row.slice(2))).toEqual(
      plainRows(idle).map((row) => row.slice(0, 1) + row.slice(2)),
    );
    expect(hovered.join("\n")).not.toContain("[ click");
  });

  test("any row of a thought that can open opens it, and any row of the open thought closes it", async () => {
    const thought = thoughtSession(long);
    await Bun.sleep(10);
    thought.rows();
    // A middle body row: neither the heading nor the notice.
    thought.mouse("click", 3);
    const open = thought.rows();
    expect(open).toHaveLength(41);
    expect(open.join("\n")).not.toContain("[ click");
    expect(open.map(barCell).every((cell) => cell === "none")).toBe(true);
    thought.mouse("click", 25);
    expect(thought.rows()).toHaveLength(8);
    thought.mouse("click", 0);
    expect(thought.rows()).toHaveLength(41);
  });

  test("a thought shown whole stays inert: no bar, and a click changes nothing", async () => {
    const thought = thoughtSession("one\ntwo");
    await Bun.sleep(10);
    const idle = thought.rows();
    thought.mouse("move", 1);
    expect(thought.rows()).toEqual(idle);
    thought.mouse("click", 1);
    expect(thought.rows()).toEqual(idle);
  });
});
