import { describe, expect, test } from "bun:test";
import { asciicast, distinct, frameOutput } from "./capture.ts";
import { checkStop, parseOptions, replaySession } from "./run.ts";
import { buildScript, parseSession } from "./session.ts";
import { parseStop } from "./stops.ts";

const FIXTURE = `${import.meta.dir}/fixtures/synthetic.jsonl`;
const script = async (startTurn?: number) => buildScript(parseSession(await Bun.file(FIXTURE).text()), { startTurn });

describe("parseOptions", () => {
  test("reads stops, sizes and outputs, and keeps actions in order", () => {
    const options = parseOptions([
      "session.jsonl",
      "--until",
      "message:5@40%",
      "--speed",
      "2",
      "--width",
      "100",
      "--theme",
      "light",
      "--click",
      "Ran 6",
      "--hover",
      "bash",
      "--gif",
      "out.gif",
    ]);
    expect(options.session).toEndWith("/session.jsonl");
    expect(options.until).toEqual({ kind: "message", message: 5, pct: 40 });
    expect(options).toMatchObject({ speed: 2, width: 100, height: 40, theme: "light" });
    expect(options.actions).toEqual([
      { kind: "click", text: "Ran 6" },
      { kind: "hover", text: "bash" },
    ]);
    expect(options.gif).toEndWith("/out.gif");
  });

  test("rejects what it cannot use", () => {
    expect(() => parseOptions([])).toThrow("session file is required");
    expect(() => parseOptions(["a.jsonl", "--speed", "0"])).toThrow("--speed");
    expect(() => parseOptions(["a.jsonl", "--theme", "blue"])).toThrow("--theme");
    expect(() => parseOptions(["a.jsonl", "--start", "message:2"])).toThrow("--start takes turn:N");
    expect(() => parseOptions(["a.jsonl", "b.jsonl"])).toThrow("unknown argument");
  });
});

describe("checkStop", () => {
  test("accepts points the live replay reaches and names the ones it does not", async () => {
    const full = await script();
    for (const spec of ["turn:3", "message:8@50%", "tool:17:end", "tool:toolu_bash_2", "end"])
      expect(() => checkStop(full, parseStop(spec), "--until")).not.toThrow();
    expect(() => checkStop(full, parseStop("message:9"), "--until")).toThrow("no such message");
    const late = await script(3);
    expect(() => checkStop(late, parseStop("turn:1"), "--until")).toThrow("no such turn");
    expect(() => checkStop(late, parseStop("tool:4"), "--until")).toThrow("no such tool call");
  });
});

describe("replaySession", () => {
  test("a fresh header in the replay's directory, the history, then the replay model", async () => {
    const lines = replaySession(await script(2), "/tmp/work/acme-app", "claude-synthetic-1")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: "/tmp/work/acme-app" });
    expect(lines.filter((line) => line.type === "session")).toHaveLength(1);
    const model = lines.at(-2);
    expect(model).toMatchObject({ type: "model_change", provider: "replay", modelId: "claude-synthetic-1" });
    expect(model.parentId).toBe(lines.at(-3).id);
    expect(lines.at(-1)).toMatchObject({ type: "thinking_level_change", thinkingLevel: "medium", parentId: model.id });
    expect(JSON.stringify(lines)).toContain("Fixed. `greet` used an undefined `nam`");
    expect(JSON.stringify(lines)).not.toContain("Run the linter and the type checker.");
  });
});

describe("capture", () => {
  test("a frame clears the screen and redraws every row, cursor hidden", () => {
    const output = frameOutput("\x1b[31mred\x1b[39m\nplain\n");
    expect(output).toStartWith("\x1b[?25l\x1b[0m\x1b[H\x1b[2J");
    expect(output).toContain("\x1b[31mred\x1b[39m\r\nplain");
    expect(output).not.toEndWith("\r\n\x1b[0m");
  });

  test("a style tmux carries from one row to the next is not reset between them", () => {
    // tmux wrote the background once, on the first row, and resets it only before the last.
    const output = frameOutput("\x1b[48;2;1;2;3m one\n\n two\n\x1b[49m three\n");
    expect(output).toContain("\x1b[48;2;1;2;3m one\r\n\r\n two\r\n\x1b[49m three");
  });

  test("a cast is an asciicast v2 header and one output event per frame", () => {
    const cast = asciicast(
      distinct([
        { time: 0, pane: "a" },
        { time: 0.1, pane: "a" },
        { time: 0.25, pane: "b" },
      ]),
      80,
      24,
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(cast[0]).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(cast.slice(1).map((event: unknown[]) => [event[0], event[1]])).toEqual([
      [0, "o"],
      [0.25, "o"],
    ]);
  });
});
