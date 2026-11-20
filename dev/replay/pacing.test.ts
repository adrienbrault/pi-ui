import { describe, expect, test } from "bun:test";
import { deltas, planMessage } from "./pacing.ts";

const chars = (count: number) => "x".repeat(count);

describe("planMessage", () => {
  test("a thinking block takes its recorded time; the rest of the duration comes before the first delta", () => {
    const plan = planMessage(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: chars(400) },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: chars(386) } },
        ],
        piUiThinkingMs: { 0: 3000 },
        // 400 characters of arguments, 100 estimated tokens, at 50 tokens/s: 2 s.
        piUiThroughput: { output: [{ id: "c1", rate: 50 }] },
      },
      8000,
    );
    expect(plan.blocks.map((block) => [block.kind, block.durationMs])).toEqual([
      ["thinking", 3000],
      ["toolCall", 2000],
    ]);
    expect(plan.latencyMs).toBe(3000);
    expect(plan.chars).toBe(800);
  });

  test("older sessions' prism keys pace the same way", () => {
    const plan = planMessage(
      { role: "assistant", content: [{ type: "thinking", thinking: chars(40) }], prismThinkingMs: { 0: 1500 } },
      4000,
    );
    expect(plan.blocks[0]!.durationMs).toBe(1500);
    expect(plan.latencyMs).toBe(2500);
  });

  test("without any recorded rate, streaming fills three quarters of the duration", () => {
    const plan = planMessage({ role: "assistant", content: [{ type: "text", text: chars(400) }] }, 4000);
    expect(plan.blocks[0]!.durationMs).toBe(3000);
    expect(plan.latencyMs).toBe(1000);
  });

  test("blocks without a recording stream at the median recorded rate", () => {
    const plan = planMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: chars(400) },
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
        ],
        piUiThroughput: { output: [{ id: "c1", rate: 100 }] },
      },
      10_000,
    );
    // 100 tokens of text at 100 tokens/s.
    expect(plan.blocks[0]!.durationMs).toBe(1000);
  });

  test("rates that overrun the duration shrink to fit it, with no wait before the first delta", () => {
    const plan = planMessage(
      { role: "assistant", content: [{ type: "thinking", thinking: chars(4000) }], piUiThinkingRates: { 0: 4.7 } },
      2000,
    );
    expect(plan.blocks[0]!.durationMs).toBe(2000);
    expect(plan.latencyMs).toBe(0);
  });

  test("an empty thinking block keeps its recorded time and streams nothing", () => {
    const plan = planMessage(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "hi" },
        ],
        piUiThinkingMs: { 0: 900 },
      },
      2000,
    );
    expect(plan.blocks[0]).toMatchObject({ kind: "thinking", durationMs: 900, text: "" });
    expect(deltas(plan.blocks[0]!)).toEqual([]);
    // The text shares what is left of three quarters of the duration.
    expect(plan.blocks[1]!.durationMs).toBe(600);
    expect(plan.latencyMs).toBe(500);
  });
});

describe("deltas", () => {
  test("rebuild the block's text and add up to its duration", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const pieces = deltas({ index: 0, kind: "text", text, durationMs: 2000 });
    expect(pieces.map((piece) => piece.text).join("")).toBe(text);
    expect(pieces).toHaveLength(50);
    expect(pieces.reduce((sum, piece) => sum + piece.delayMs, 0)).toBeCloseTo(2000);
  });

  test("never split a surrogate pair, and give a short block fewer, longer steps", () => {
    const pieces = deltas({ index: 0, kind: "text", text: "a😀b", durationMs: 5000 });
    expect(pieces.map((piece) => piece.text)).toEqual(["a", "😀", "b"]);
  });

  test("an instant block is one delta", () => {
    expect(deltas({ index: 0, kind: "text", text: "hello", durationMs: 0 })).toEqual([{ delayMs: 0, text: "hello" }]);
  });
});
