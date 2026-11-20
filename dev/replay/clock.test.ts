import { describe, expect, test } from "bun:test";
import { busyIn, GO_AT, type RealTimers, VirtualClock, WALL_EPOCH } from "./clock.ts";

/** Real timers the test turns by hand: `flush()` runs every queued turn until none is left. */
function fakeReal(options: { busy?: () => boolean } = {}) {
  let realNow = 0;
  let queue: Array<{ at: number; callback: () => void; id: number }> = [];
  let ids = 0;
  const real: RealTimers = {
    setTimeout: (callback, ms) => {
      const id = ++ids;
      queue.push({ at: realNow + ms, callback, id });
      return id;
    },
    clearTimeout: (handle) => {
      queue = queue.filter((entry) => entry.id !== handle);
    },
    setImmediate: (callback) => {
      queue.push({ at: realNow, callback, id: ++ids });
      return ids;
    },
    now: () => realNow,
    busy: options.busy ?? (() => false),
  };
  /** Runs up to `turns` real turns; true when nothing was left to run. */
  const flush = (turns = 10_000): boolean => {
    for (let turn = 0; turn < turns; turn++) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue.shift();
      if (!next) return true;
      realNow = Math.max(realNow, next.at);
      next.callback();
    }
    return false;
  };
  return { real, flush, advanceReal: (ms: number) => (realNow += ms) };
}

describe("VirtualClock", () => {
  test("fast: runs timers in due order, each reading the time it was due at", () => {
    const { real, flush } = fakeReal();
    const clock = new VirtualClock(real, "fast");
    const seen: Array<[string, number]> = [];
    clock.setTimeout(() => seen.push(["b", clock.now()]), 30);
    clock.setTimeout(() => seen.push(["a", clock.now()]), 10);
    clock.setTimeout(() => seen.push(["c", clock.now()]), 30);
    flush();
    expect(seen).toEqual([
      ["a", 10],
      ["b", 30],
      ["c", 30],
    ]);
  });

  test("an interval runs once per period until cleared; a cleared timeout never runs", () => {
    const { real, flush } = fakeReal();
    const clock = new VirtualClock(real, "fast");
    const ticks: number[] = [];
    const interval = clock.setInterval(() => {
      ticks.push(clock.now());
      if (ticks.length === 3) clock.clear(interval);
    }, 80);
    const never = clock.setTimeout(() => ticks.push(-1), 100);
    clock.clear(Number(never));
    flush();
    expect(ticks).toEqual([80, 160, 240]);
    expect(clock.pending()).toBe(0);
  });

  test("hold stops time at its limit and settles there; release lets later timers run", async () => {
    const { real, flush } = fakeReal();
    const clock = new VirtualClock(real, "fast");
    const ran: number[] = [];
    clock.setInterval(() => ran.push(clock.now()), 100);
    let settled = false;
    void clock.hold(250).then(() => (settled = true));
    expect(flush()).toBe(true);
    await Promise.resolve();
    expect(ran).toEqual([100, 200]);
    expect(clock.now()).toBe(250);
    expect(settled).toBe(true);
    clock.release();
    flush(5);
    expect(ran.length).toBeGreaterThan(2);
  });

  test("no timer runs while a real request is in flight", () => {
    let busy = true;
    const { real, flush, advanceReal } = fakeReal({ busy: () => busy });
    const clock = new VirtualClock(real, "fast");
    const ran: number[] = [];
    clock.setTimeout(() => ran.push(clock.now()), 5);
    flush(50);
    expect(ran).toEqual([]);
    expect(clock.now()).toBe(0);
    busy = false;
    advanceReal(1);
    flush();
    expect(ran).toEqual([5]);
  });

  test("paced: a timer waits for real time as well", () => {
    const { real, flush } = fakeReal();
    const clock = new VirtualClock(real, "paced");
    const ran: number[] = [];
    clock.setTimeout(() => ran.push(real.now()), 40);
    flush();
    expect(ran).toEqual([40]);
  });

  test("go jumps to a fixed time, whatever startup took, and the wall clock follows", () => {
    const { real, flush } = fakeReal();
    const clock = new VirtualClock(real, "paced");
    const ran: number[] = [];
    clock.setTimeout(() => ran.push(clock.now()), 1234);
    expect(clock.go("fast")).toBe(true);
    flush();
    expect(ran).toEqual([GO_AT]);
    expect(clock.wallNow()).toBe(WALL_EPOCH);
  });

  test("a handle refreshes, unrefs and converts to its id like node's", () => {
    const { real, flush } = fakeReal();
    const clock = new VirtualClock(real, "fast");
    const ran: number[] = [];
    const handle = clock.setTimeout(() => ran.push(clock.now()), 50);
    expect(handle.unref().hasRef()).toBe(false);
    clock.setTimeout(() => handle.refresh(), 30);
    flush();
    expect(ran).toEqual([80]);
    expect(Number(handle)).toBe(handle.id);
  });
});

describe("busyIn", () => {
  test("open requests are busy; handles that stay open are not", () => {
    expect(busyIn(["TTYWrap", "TTYWrap", "Timeout", "FSEventWrap"])).toBe(false);
    expect(busyIn(["TTYWrap", "FSReqCallback"])).toBe(true);
    expect(busyIn(["ProcessWrap", "PipeWrap"])).toBe(true);
  });
});
