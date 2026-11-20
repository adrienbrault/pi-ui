import { describe, expect, test } from "bun:test";
import {
  activePath,
  type AssistantStep,
  buildScript,
  type Entry,
  liveSteps,
  nextAssistant,
  outline,
  parseSession,
  type PromptStep,
  promptBefore,
  responseIdOf,
  steerAfter,
} from "./session.ts";

const FIXTURE = `${import.meta.dir}/fixtures/synthetic.jsonl`;
const fixture = async () => parseSession(await Bun.file(FIXTURE).text());

/** A linear session from compact message specs: `user:text`, `assistant` objects, `result:callId`. */
function session(...items: Array<string | Record<string, unknown>>): Entry[] {
  const entries: Entry[] = [{ type: "session", version: 3, id: "header", cwd: "/work/project" }];
  let parentId: string | null = null;
  let clock = 1_000_000;
  for (const [index, item] of items.entries()) {
    const id = `e${index}`;
    clock += 1000;
    let entry: Entry;
    if (typeof item === "string" && item.startsWith("user:")) {
      entry = {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: item.slice(5) }], timestamp: clock },
      };
    } else if (typeof item === "string" && item.startsWith("result:")) {
      const [, callId, error] = item.split(":");
      entry = {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "bash",
          content: [{ type: "text", text: "out" }],
          isError: !!error,
          timestamp: clock,
          durationMs: 300,
        },
      };
    } else if (typeof item === "string") {
      entry = { type: item };
    } else if (item.role) {
      entry = { type: "message", message: { timestamp: clock, durationMs: 500, ...item } as Entry["message"] };
    } else {
      entry = { ...item } as Entry;
    }
    entries.push({ ...entry, id, parentId, timestamp: new Date(clock).toISOString() });
    parentId = id;
  }
  return entries;
}

const assistant = (content: unknown[], stopReason = "toolUse", extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  stopReason,
  model: "model-a",
  ...extra,
});
const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
const text = (value: string) => ({ type: "text", text: value });

describe("parseSession and activePath", () => {
  test("a line that is not JSON names its line number", () => {
    expect(() => parseSession('{"type":"session"}\n{oops\n')).toThrow("line 2");
  });

  test("the active branch is the last entry's ancestry: an abandoned branch is left out", async () => {
    const script = buildScript(await fixture());
    const prompts = script.steps.filter((step): step is PromptStep => step.kind === "prompt").map((step) => step.text);
    expect(prompts).toEqual([
      "The greeting test fails. Find out why and fix it.",
      "Run the linter and the type checker.",
      "Check that every package builds.",
    ]);
    expect(JSON.stringify(script.steps)).not.toContain("abandoned");
  });

  test("an explicit leaf selects another branch", async () => {
    const entries = await fixture();
    const abandoned = entries.find((entry) => JSON.stringify(entry.message?.content ?? "").includes("abandoned"))!;
    const path = activePath(entries, abandoned.id);
    expect(path.at(-1)).toBe(abandoned);
    expect(path.filter((entry) => entry.message?.role === "user")).toHaveLength(2);
  });

  test("a parentId cycle is an error, not a hang", () => {
    const entries: Entry[] = [
      { type: "message", id: "a", parentId: "b" },
      { type: "message", id: "b", parentId: "a" },
    ];
    expect(() => activePath(entries)).toThrow("cycle");
  });
});

describe("buildScript", () => {
  test("numbers turns, messages and tool calls over the path, with results attached by call id", async () => {
    const script = buildScript(await fixture());
    const messages = script.steps.filter((step): step is AssistantStep => step.kind === "assistant");
    expect(messages.map((step) => [step.index, step.turn])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 2],
      [6, 2],
      [7, 3],
      [8, 3],
    ]);
    expect(script.tools).toHaveLength(17);
    expect(script.tools.map((tool) => tool.index)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    const lint = script.tools.find((tool) => tool.id === "toolu_bash_2")!;
    expect(lint).toMatchObject({ index: 4, message: 5, turn: 2, result: { isError: true, durationMs: 1400 } });
    expect(script.toolNames).toEqual(["read", "edit", "bash"]);
    expect(script.models).toEqual(["claude-synthetic-1"]);
    expect(script.model).toBe("claude-synthetic-1");
    expect(script.thinkingLevel).toBe("medium");
    expect(script.cwd).toBe("/home/dev/acme-app");
  });

  test("a message takes its recorded duration, and a prompt the time since the previous message ended", async () => {
    const script = buildScript(await fixture());
    const first = script.steps.find((step): step is AssistantStep => step.kind === "assistant")!;
    expect(first.durationMs).toBe(4200);
    const second = script.steps.filter((step): step is PromptStep => step.kind === "prompt")[1]!;
    // The abandoned branch's 2 s prompt and 1.2 s answer sit between, then the 4 s pause.
    expect(second.gapMs).toBe(7200);
  });

  test("a prompt after a tool result is a steer in the run it interrupts", () => {
    const script = buildScript(
      session(
        "user:go",
        assistant([call("c1")]),
        "result:c1",
        "user:also this",
        assistant([text("ok")], "stop"),
        "user:next",
      ),
    );
    const prompts = script.steps.filter((step): step is PromptStep => step.kind === "prompt");
    expect(prompts.map((step) => [step.turn, step.steer])).toEqual([
      [1, false],
      [1, true],
      [2, false],
    ]);
    const first = script.steps.find((step): step is AssistantStep => step.kind === "assistant")!;
    expect(steerAfter(script, first)?.text).toBe("also this");
  });

  test("empty error messages a retry replaced are left out of the numbering; an aborted message stays", () => {
    const script = buildScript(
      session(
        "user:go",
        assistant([], "error", { errorMessage: "Connection error." }),
        assistant([], "error", { errorMessage: "Connection error." }),
        assistant([text("partial")], "aborted"),
        "user:again",
        assistant([text("done")], "stop"),
      ),
    );
    const messages = script.steps.filter((step): step is AssistantStep => step.kind === "assistant");
    expect(messages.map((step) => [step.index, step.message.stopReason])).toEqual([
      [1, "aborted"],
      [2, "stop"],
    ]);
    expect(script.skipped.map((skip) => skip.what)).toEqual(["empty error message", "empty error message"]);
  });

  test("the live replay starts at the first prompt after the last compaction; the rest is history", () => {
    const entries = session(
      "user:one",
      assistant([text("a")], "stop"),
      { type: "compaction", summary: "first", firstKeptEntryId: "e0" },
      "user:two",
      assistant([text("b")], "stop"),
      { type: "compaction", summary: "second", firstKeptEntryId: "e3" },
      assistant([text("after the compaction")], "stop"),
      "user:three",
      assistant([text("c")], "stop"),
    );
    const script = buildScript(entries);
    expect(script.startReason).toContain("compaction");
    expect(liveSteps(script).map((step) => (step.kind === "prompt" ? step.text : step.index))).toEqual(["three", 4]);
    expect(script.history.map((entry) => entry.id)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6"]);
    // Numbering stays global: turn three is the third turn.
    expect(liveSteps(script)[0]).toMatchObject({ kind: "prompt", turn: 3 });
  });

  test("startTurn loads earlier turns as history", async () => {
    const script = buildScript(await fixture(), { startTurn: 2 });
    expect(script.startReason).toBe("--start turn:2");
    const live = liveSteps(script);
    expect(live[0]).toMatchObject({ kind: "prompt", turn: 2 });
    expect(live.filter((step) => step.kind === "assistant").map((step) => (step as AssistantStep).index)).toEqual([
      5, 6, 7, 8,
    ]);
    expect(script.history.some((entry) => entry.message?.role === "assistant")).toBe(true);
  });

  test("custom entries and other roles in the live part are listed as not replayed", () => {
    const script = buildScript(
      session(
        "user:go",
        { type: "custom", customType: "x" },
        { role: "bashExecution", command: "ls" },
        assistant([text("ok")], "stop"),
      ),
    );
    expect(script.skipped.map((skip) => skip.what)).toEqual(["custom", "bashExecution message"]);
  });

  test("the outline lists turns, messages and tools by number", async () => {
    const listing = outline(buildScript(await fixture()));
    expect(listing).toContain("turn 2: Run the linter and the type checker.");
    expect(listing).toContain("message 5: 3.0s, thinking 62c");
    expect(listing).toContain("tool 4 bash toolu_bash_2: 1.4s failed");
  });
});

describe("nextAssistant", () => {
  test("follows the last replayed message in the context, ignoring other responses", async () => {
    const script = buildScript(await fixture());
    expect(nextAssistant(script, [{ role: "user" }])?.index).toBe(1);
    const context = [
      { role: "user" },
      { role: "assistant", responseId: responseIdOf(1) },
      { role: "toolResult" },
      { role: "assistant", responseId: "resp_provider_123" },
    ];
    expect(nextAssistant(script, context)?.index).toBe(2);
    expect(nextAssistant(script, [{ role: "assistant", responseId: responseIdOf(8) }])).toBeUndefined();
  });

  test("a retried request passes over an error message already emitted", () => {
    const script = buildScript(
      session("user:go", assistant([text("rate limited")], "error"), assistant([text("ok")], "stop")),
    );
    expect(nextAssistant(script, [{ role: "user" }])?.index).toBe(1);
    expect(nextAssistant(script, [{ role: "user" }], new Set([1]))?.index).toBe(2);
  });

  test("starts at the first live message when history precedes it", async () => {
    const script = buildScript(await fixture(), { startTurn: 3 });
    expect(nextAssistant(script, [{ role: "assistant", responseId: "resp_old" }, { role: "user" }])?.index).toBe(7);
  });

  test("the prompt before a message is the one it answers", async () => {
    const script = buildScript(await fixture());
    const sixth = script.steps.find((step): step is AssistantStep => step.kind === "assistant" && step.index === 6)!;
    expect(promptBefore(script, sixth)?.text).toBe("Run the linter and the type checker.");
  });
});
