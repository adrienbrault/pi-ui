import { expect, jest, test } from "bun:test";
import { installThinkingClock, recordedThinkingMs, thinkingTime } from "./thinking-time.ts";

test("each visible thinking run finishes on its own clock and survives restore or interruption", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let repaints = 0;
  installThinkingClock(
    { on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never,
    () => repaints++,
  );
  const message = {
    role: "assistant",
    durationMs: 8500,
    content: [{ type: "thinking" }, { type: "thinking" }, { type: "text" }, { type: "thinking" }],
  };
  const update = (type: string, contentIndex: number) =>
    handlers.get("message_update")!({ message, assistantMessageEvent: { type, contentIndex } }, { mode: "tui" });
  jest.useFakeTimers();
  try {
    update("thinking_start", 0);
    jest.advanceTimersByTime(300);
    update("thinking_end", 0);
    update("thinking_start", 1);
    jest.advanceTimersByTime(400);
    expect(thinkingTime(message, 0, true)).toEqual({ running: true, durationMs: 700, outputRate: null });
    update("thinking_end", 1);
    const count = repaints;
    jest.advanceTimersByTime(3000);
    expect(repaints).toBe(count);
    update("thinking_start", 3);
    jest.advanceTimersByTime(900);
    const { message: saved } = handlers.get("message_end")!({ message: { ...message, stopReason: "aborted" } });
    expect(saved.piUiThinkingMs).toEqual({ 0: 700, 3: 900 });
    expect(thinkingTime(JSON.parse(JSON.stringify(saved)), 3, false).durationMs).toBe(900);
    expect(thinkingTime(message, 0, false)).toEqual({
      durationMs: 8500,
      running: false,
      turnDuration: true,
      outputRate: undefined,
    });
  } finally {
    handlers.get("session_shutdown")!();
    jest.useRealTimers();
  }
});

test("the displayed thinking rate holds between the last delta and a delayed end, including after reload", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  installThinkingClock(
    { on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } as never,
    () => {},
  );
  const message = { role: "assistant", durationMs: 8500, content: [{ type: "thinking" }] };
  const update = (type: string, delta = "") =>
    handlers.get("message_update")!(
      { message, assistantMessageEvent: { type, delta, contentIndex: 0 } },
      { mode: "tui" },
    );
  jest.useFakeTimers();
  try {
    update("thinking_start");
    update("thinking_delta", "start");
    jest.advanceTimersByTime(1000);
    update("thinking_delta", "more".repeat(20));
    const rate = () => thinkingTime(message, 0, true).outputRate;
    expect(rate()).toBe(20);
    jest.advanceTimersByTime(3500);
    expect(rate()).toBe(20);
    update("thinking_end");
    expect(rate()).toBe(20);
    const { message: saved } = handlers.get("message_end")!({ message });
    expect(thinkingTime(JSON.parse(JSON.stringify(saved)), 0, false).outputRate).toBe(20);
    expect(saved.piUiThinkingMs[0]).toBe(1000);
  } finally {
    handlers.get("session_shutdown")!();
    jest.useRealTimers();
  }
});

test("a message saved before the rename to pi-ui keeps its thinking time and rate", () => {
  const message = { durationMs: 8500, prismThinkingMs: { 0: 1200 }, prismThinkingRates: { 0: 30 } };
  expect(recordedThinkingMs(message)).toEqual({ 0: 1200 });
  expect(thinkingTime(message, 0, false)).toEqual({
    durationMs: 1200,
    turnDuration: false,
    running: false,
    outputRate: 30,
  });
});
