import { describe, expect, test } from "bun:test";
import { formatStop, parseStop, reached } from "./stops.ts";

const progress = (message: number, pct: number) => ({
  type: "progress" as const,
  message,
  pct,
  block: 0,
  kind: "text",
});

describe("parseStop", () => {
  test("reads every form", () => {
    expect(parseStop("turn:3")).toEqual({ kind: "turn", turn: 3 });
    expect(parseStop("message:7")).toEqual({ kind: "message", message: 7, pct: 100 });
    expect(parseStop("message:7@40%")).toEqual({ kind: "message", message: 7, pct: 40 });
    expect(parseStop("message:7@12.5")).toEqual({ kind: "message", message: 7, pct: 12.5 });
    expect(parseStop("tool:4")).toEqual({ kind: "tool", tool: 4, at: "start" });
    expect(parseStop("tool:4:end")).toEqual({ kind: "tool", tool: 4, at: "end" });
    expect(parseStop("tool:call_abc|fc_1:end")).toEqual({ kind: "tool", tool: "call_abc|fc_1", at: "end" });
    expect(parseStop("end")).toEqual({ kind: "end" });
  });

  test("rejects what it cannot read", () => {
    for (const spec of ["turn:0", "turn:x", "message:2@150%", "message:", "tool:", "step:1", ""])
      expect(() => parseStop(spec)).toThrow("bad stop");
  });

  test("formats back to a spec it reads", () => {
    for (const spec of ["turn:3", "message:7", "message:7@40%", "tool:4:end", "tool:abc:start", "end"])
      expect(parseStop(formatStop(parseStop(spec)))).toEqual(parseStop(spec));
  });
});

describe("reached", () => {
  test("a turn is reached when pi settles after it", () => {
    const stop = parseStop("turn:2");
    expect(reached(stop, { type: "settled", turn: 1 })).toBe(false);
    expect(reached(stop, { type: "settled", turn: 2 })).toBe(true);
    expect(reached(stop, { type: "prompt", turn: 2, steer: false })).toBe(false);
  });

  test("a percentage is reached mid-stream; a whole message when it ends", () => {
    const mid = parseStop("message:3@50%");
    expect(reached(mid, progress(3, 49))).toBe(false);
    expect(reached(mid, progress(2, 90))).toBe(false);
    expect(reached(mid, progress(3, 50))).toBe(true);
    // An empty message reports no progress: its end stands in.
    expect(reached(mid, { type: "message_end", message: 3, stopReason: "stop" })).toBe(true);
    const whole = parseStop("message:3");
    expect(reached(whole, progress(3, 100))).toBe(false);
    expect(reached(whole, { type: "message_end", message: 3, stopReason: "toolUse" })).toBe(true);
  });

  test("a tool is matched by number or id, at its start or its end", () => {
    const start = { type: "tool_start" as const, tool: 4, id: "c4", name: "bash" };
    const end = { type: "tool_end" as const, tool: 4, id: "c4", name: "bash", isError: false };
    expect(reached(parseStop("tool:4"), start)).toBe(true);
    expect(reached(parseStop("tool:4"), end)).toBe(false);
    expect(reached(parseStop("tool:c4:end"), end)).toBe(true);
    expect(reached(parseStop("tool:5"), start)).toBe(false);
  });

  test("end is the finished event", () => {
    expect(reached(parseStop("end"), { type: "finished" })).toBe(true);
    expect(reached(parseStop("end"), { type: "settled", turn: 9 })).toBe(false);
  });
});
