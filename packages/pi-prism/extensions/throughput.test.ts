import { expect, jest, test } from "bun:test";
import { installThroughput, serverRates } from "./throughput.ts";

test("prefill throughput uses processed uncached tokens and server time", () => {
  expect(serverRates({ prompt_progress: { processed: 1200, cache: 1000, time_ms: 100 } }).inputRate).toBe(2000);
  for (const progress of [
    { processed: 1000, cache: 1000, time_ms: 100 },
    { processed: 2000, time_ms: 100 },
    { processed: 2000, cache: -1, time_ms: 100 },
    { processed: 2000, cache: 1000, time_ms: 0 },
  ])
    expect(serverRates({ prompt_progress: progress }).inputRate).toBeUndefined();
  expect(serverRates({ timings: { prompt_n: 1500, prompt_ms: 300 } }).inputRate).toBe(5000);
  expect(serverRates({ usage: { prompt_tokens: 1200, completion_tokens: 40 } }).inputRate).toBeUndefined();
  expect(serverRates({ usage: { prompt_tokens_per_sec: 1400, completion_tokens_per_sec: 30 } })).toMatchObject({
    inputRate: 1400,
    outputRate: 30,
  });
});

test("live rates follow generation and the subsequent consuming request, then restore from its branch", () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let label: string | undefined;
  const branch: unknown[] = [];
  const ctx = {
    mode: "tui",
    model: { provider: "llamacpp", api: "openai-completions" },
    ui: { setStatus: (_: string, text?: string) => (label = text) },
    sessionManager: { getBranch: () => branch },
  };
  const rates = installThroughput({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, () => {});
  const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const message = { role: "assistant", content: [{ type: "toolCall", id: "a" }] };
  const delta = (fragment: string) =>
    emit("message_update", {
      message,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: fragment },
    });
  const raw = (data: unknown) => emit("provider_stream_event", { data });
  const finish = (msg: unknown) => {
    const saved = emit("message_end", { message: msg });
    branch.push({ type: "message", message: saved.message });
  };
  jest.useFakeTimers();
  try {
    expect(emit("before_provider_request", { payload: { stream: true, model: "x" } })).toEqual({
      stream: true,
      model: "x",
      return_progress: true,
      timings_per_token: true,
    });
    delta("first");
    jest.advanceTimersByTime(200);
    delta("12345678");
    expect(rates("a")).toEqual({ outputRate: 10 });
    finish(message);
    emit("context_with_system", {
      messages: [
        { role: "toolResult", toolCallId: "old" },
        message,
        { role: "toolResult", toolCallId: "a" },
        { role: "toolResult", toolCallId: "b" },
      ],
    });
    ctx.model.provider = "cloud";
    expect(
      emit("before_provider_request", {
        payload: {
          stream: true,
          messages: [
            { role: "assistant", content: "old context" },
            { role: "tool", content: "12345678" },
          ],
        },
      }),
    ).toBeUndefined();
    jest.advanceTimersByTime(100);
    const textDelta = (fragment: string) =>
      emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: fragment } });
    textDelta("");
    jest.advanceTimersByTime(100);
    textDelta("first");
    expect(rates("b")).toEqual({ inputRate: 10, inputRateEstimated: true });
    jest.advanceTimersByTime(500);
    textDelta("second");
    expect(rates("b")?.inputRate).toBe(10);
    emit("before_provider_request", { payload: { stream: true } });
    raw({ prompt_progress: { processed: 2000, cache: 1000, time_ms: 250 } });
    expect(label).toBe("prefill 4k tok/s");
    expect(rates("a")).toEqual({ outputRate: 10, inputRate: 4000 });
    expect(rates("b")).toEqual({ inputRate: 4000 });
    expect(rates("old")).toBeUndefined();
    emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "ok" } });
    expect(label).toBeUndefined();
    raw({ timings: { prompt_per_second: 3000, predicted_per_second: 45 } });
    finish({ role: "assistant", content: [{ type: "toolCall", id: "batched" }] });
    emit("session_shutdown");
    expect(rates("a")).toBeUndefined();
    emit("session_start");
    expect(rates("a")).toEqual({ outputRate: 10, inputRate: 3000 });
    expect(rates("batched")).toEqual({ outputRate: 45 });
    branch.pop();
    emit("session_tree");
    expect(rates("a")).toEqual({ outputRate: 10 });
  } finally {
    jest.useRealTimers();
  }
});

test("a server measurement that arrives after the last tool-call delta replaces the estimate", () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const ctx = {
    mode: "tui",
    model: { provider: "llamacpp", api: "openai-completions" },
    ui: { setStatus: () => {} },
    sessionManager: { getBranch: () => [] },
  };
  const rates = installThroughput({ on: (name: string, fn: any) => handlers.set(name, fn) } as never, () => {});
  const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const message = { role: "assistant", content: [{ type: "toolCall", id: "a" }] };
  const delta = (fragment: string) =>
    emit("message_update", {
      message,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: fragment },
    });
  jest.useFakeTimers();
  try {
    emit("before_provider_request", { payload: { stream: true } });
    delta("first");
    jest.advanceTimersByTime(100);
    delta("1234567890123456");
    expect(rates("a")?.outputRate).toBe(40);
    emit("provider_stream_event", { data: { timings: { predicted_per_second: 45 } } });
    const saved = emit("message_end", { message });
    expect(saved.message.prismThroughput.output).toEqual([{ id: "a", rate: 45 }]);
    expect(rates("a")?.outputRate).toBe(45);
  } finally {
    jest.useRealTimers();
  }
});
