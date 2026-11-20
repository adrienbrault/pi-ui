// oxlint-disable no-await-in-loop -- polling waits one step at a time
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import replayExtension, { BUILTIN_TOOLS, PROVIDER, Replay, type ReplayConfig } from "./extension.ts";
import { responseIdOf } from "./session.ts";

const FIXTURE = `${import.meta.dir}/fixtures/synthetic.jsonl`;
const dir = mkdtempSync(join(tmpdir(), "pi-replay-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config = (extra: Partial<ReplayConfig> = {}): ReplayConfig => ({
  session: FIXTURE,
  speed: 1000,
  maxGapMs: 0,
  ...extra,
});

async function collect(stream: AsyncGenerator<Record<string, unknown>>) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Replay.respond", () => {
  test("streams the next recorded message delta by delta, stamped with its index", async () => {
    const replay = new Replay(config());
    replay.markSent(replay.nextPrompt()!);
    const events = await collect(replay.respond([{ role: "user" }], "claude-synthetic-1"));
    expect(events[0]!.type).toBe("start");
    const kinds = new Set(events.map((event) => event.type));
    for (const kind of [
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ])
      expect(kinds.has(kind)).toBe(true);
    const thinking = events
      .filter((event) => event.type === "thinking_delta")
      .map((event) => event.delta)
      .join("");
    expect(thinking).toStartWith("The failing test is about the greeting");
    const done = events.at(-1)!;
    expect(done).toMatchObject({
      type: "done",
      reason: "toolUse",
      message: { responseId: responseIdOf(1), provider: PROVIDER },
    });
    expect((done.message as { content: Array<{ id?: string }> }).content[1]!.id).toBe("toolu_read_1");
  });

  test("answers with nothing, and warns, until the next message's prompt has been sent", async () => {
    const lines: string[] = [];
    const replay = new Replay(config(), undefined, (line) => lines.push(line));
    const events = await collect(replay.respond([{ role: "user" }], "claude-synthetic-1"));
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: [] } });
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["warning"]);
  });

  test("--max-wait shortens a whole message or tool, in replay time", () => {
    const replay = new Replay(config({ speed: 2, maxWaitMs: 500 }));
    expect(replay.clip(100_000)).toBe(1000);
    expect(replay.clip(300)).toBe(300);
    expect(new Replay(config()).clip(100_000)).toBe(100_000);
  });

  test("pauses at the stop: progress stops at the percentage and waits until released", async () => {
    const lines: string[] = [];
    const replay = new Replay(config({ until: "message:1@50%", speed: 100 }), undefined, (line) => lines.push(line));
    replay.markSent(replay.nextPrompt()!);
    const stream = replay.respond([{ role: "user" }], "claude-synthetic-1");
    const seen: Array<Record<string, unknown>> = [];
    const pump = (async () => {
      for await (const event of stream) seen.push(event);
    })();
    for (let i = 0; i < 200 && !replay.isPaused; i++) await Bun.sleep(5);
    expect(replay.isPaused).toBe(true);
    await Bun.sleep(100);
    const streamed = seen.filter((event) => event.type === "thinking_delta").length;
    await Bun.sleep(100);
    expect(seen.filter((event) => event.type === "thinking_delta").length).toBe(streamed);
    expect(seen.some((event) => event.type === "done")).toBe(false);
    const paused = lines.map((line) => JSON.parse(line)).find((event) => event.type === "paused");
    expect(paused).toMatchObject({ stop: "message:1@50%" });
    void pump;
  });

  test("a tool returns its recorded result after streaming a command's output", async () => {
    const replay = new Replay(config({ speed: 4 }));
    const updates: string[] = [];
    const result = await replay.execute("toolu_bash_1", "bash", (partial) =>
      updates.push((partial.content[0] as { text: string }).text),
    );
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("1 pass") })]);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]!.length).toBeLessThan(updates.at(-1)!.length);
    const missing = await replay.execute("nope", "bash");
    expect(JSON.stringify(missing.content)).toContain("no recorded result");
  });
});

function load(extra: Partial<ReplayConfig> = {}) {
  const control = mkdtempSync(join(dir, "control-"));
  const path = join(dir, `config-${Math.random()}.json`);
  writeFileSync(path, JSON.stringify(config({ control, ...extra })));
  process.env.PI_REPLAY_CONFIG = path;
  const providers = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, Record<string, any>>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  replayExtension({
    registerProvider: (name, provider) => providers.set(name, provider),
    registerTool: (tool) => tools.set(String(tool.name), tool),
    sendUserMessage: () => {},
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  });
  delete process.env.PI_REPLAY_CONFIG;
  const fire = (event: string, payload: unknown) => handlers.get(event)?.map((handler) => handler(payload, {}));
  return { providers, tools, fire, control };
}

describe("the extension", () => {
  test("registers the replay provider with the recorded models, and every built-in and recorded tool", () => {
    const { providers, tools } = load();
    const models = providers.get(PROVIDER)!.models as Array<{ id: string; contextWindow: number }>;
    expect(models.map((model) => model.id)).toEqual(["claude-synthetic-1"]);
    expect(models[0]!.contextWindow).toBeGreaterThan(10_000_000);
    expect([...tools.keys()].toSorted()).toEqual([...BUILTIN_TOOLS].toSorted());
    expect(tools.get("bash")!.parameters).toEqual({ type: "object", additionalProperties: true });
  });

  test("the recorded result replaces whatever pi-ui measured in the working directory", () => {
    const { fire } = load();
    const [patch] = fire("tool_result", {
      toolCallId: "toolu_bash_2",
      details: { piUiChanges: { files: [{ path: "real.txt" }] } },
      isError: false,
    })!;
    expect(patch.isError).toBe(true);
    expect(patch.details).toEqual({});
    expect(JSON.stringify(patch.content)).toContain("no-unused-vars");
    const [edit] = fire("tool_result", { toolCallId: "toolu_edit_1" })!;
    expect(edit.details).toMatchObject({ firstChangedLine: 2 });
  });

  test("a finished message carries its recorded timing, whatever the replay speed", () => {
    const { fire } = load();
    const [patch] = fire("message_end", {
      message: { role: "assistant", responseId: responseIdOf(1), durationMs: 4 },
    })!;
    expect(patch.message).toMatchObject({ durationMs: 4200, piUiThinkingMs: { 0: 2600 } });
    expect(fire("message_end", { message: { role: "assistant", responseId: "resp_x" } })).toEqual([undefined]);
  });

  test("progress events go to the control directory", () => {
    const { fire, control } = load();
    fire("tool_execution_end", { toolCallId: "toolu_read_1", toolName: "read", isError: false });
    const events = readFileSync(join(control, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "tool_end", tool: 1, id: "toolu_read_1" });
  });
});
