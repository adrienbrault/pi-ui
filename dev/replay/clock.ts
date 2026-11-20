/**
 * A virtual clock for the replayed pi process, so that everything pi and pi-ui draw from time is
 * a function of the replay's position, never of how fast the machine ran.
 *
 * `dev/replay/clock-preload.ts` installs it before pi starts (`node --import`): `setTimeout`,
 * `setInterval`, their `clear*` twins, `Date.now`, `new Date()` and `performance.now` all read
 * and schedule on virtual time. Every timer in the process is then a virtual timer: the replay's
 * own waits (each recorded delta and tool duration), pi's loader frames, pi-tui's render
 * throttle, pi-ui's spinners, clocks, fades, backlog steps and hover expiry.
 *
 * Time advances by firing timers, one per turn of the event loop, in due order: the clock jumps to
 * a timer's due time and runs it, so a callback reads exactly the time it was due at. Two rules
 * keep the order independent of the machine:
 * - while a real request is in flight (a file read, a child process such as pi-ui's git
 *   snapshot), no timer fires: virtual time stands still during real work;
 * - `hold(ms)` stops time at a limit: timers due later wait until `release()`. The replay holds
 *   at a pause, so a paused screen stops changing, and advances by a fixed step after each mouse
 *   action, so a hover or click paints.
 * In `fast` mode the next timer fires as soon as the process is idle, so a long session replays in
 * seconds; in `paced` mode virtual time also waits for real time, for recordings that play at the
 * recorded pace. A process starts paced, so that pi's startup sees real time (a terminal's answer
 * to a query arrives before the query times out), then `go()` jumps to a fixed time and switches
 * to the replay's mode: the replay itself always starts at the same instant.
 *
 * Erasable TypeScript only: node strips the types of this file and of clock-preload.ts.
 */

export type ClockMode = "fast" | "paced";

export interface RealTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(callback: () => void): unknown;
  /** Real milliseconds, monotonic. */
  now(): number;
  /** Whether a real request is in flight, so time must not move. */
  busy(): boolean;
}

/** The replay's time zero, as wall time: 2026-01-01T09:00:00Z. */
export const WALL_EPOCH = Date.UTC(2026, 0, 1, 9, 0, 0);
/** The virtual time the replay starts at, after pi's startup. Startup must take less. */
export const GO_AT = 60_000;
export const CLOCK_KEY = Symbol.for("pi-ui.replay.clock");

/** libuv requests that finish on their own: while one is open, real work is under way. */
const REQUESTS = new Set([
  "FSReqCallback",
  "FSReqPromise",
  "FileHandleCloseReq",
  "ProcessWrap",
  "GetAddrInfoReqWrap",
  "GetNameInfoReqWrap",
  "QueryReqWrap",
  "ShutdownWrap",
  "WriteWrap",
  "ConnectWrap",
  "TCPConnectWrap",
  "PipeConnectWrap",
  "ZlibWrap",
]);

/** Whether `resources` (process.getActiveResourcesInfo()) holds an open request. */
export function busyIn(resources: readonly string[]): boolean {
  return resources.some((resource) => REQUESTS.has(resource));
}

interface Timer {
  id: number;
  due: number;
  seq: number;
  callback: () => void;
  /** Milliseconds between runs of an interval; undefined for a timeout. */
  every: number | undefined;
  delay: number;
  referenced: boolean;
  active: boolean;
}

/** A timer handle shaped like node's Timeout: ref, unref, refresh, and a numeric id. */
export class TimerHandle {
  readonly id: number;
  private readonly clock: VirtualClock;

  constructor(clock: VirtualClock, id: number) {
    this.clock = clock;
    this.id = id;
  }

  ref(): this {
    this.clock.setReferenced(this.id, true);
    return this;
  }

  unref(): this {
    this.clock.setReferenced(this.id, false);
    return this;
  }

  hasRef(): boolean {
    return this.clock.isReferenced(this.id);
  }

  refresh(): this {
    this.clock.refresh(this.id);
    return this;
  }

  close(): this {
    this.clock.clear(this);
    return this;
  }

  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

export class VirtualClock {
  private time = 0;
  private limit = Number.POSITIVE_INFINITY;
  private nextId = 1;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();
  private queue: Timer[] = [];
  private scheduled = false;
  private wake: unknown;
  private realBase: number;
  private virtualBase = 0;
  private waiters: Array<() => void> = [];
  readonly real: RealTimers;
  mode: ClockMode;

  constructor(real: RealTimers, mode: ClockMode = "paced") {
    this.real = real;
    this.mode = mode;
    this.realBase = real.now();
  }

  /** Virtual milliseconds since the process started: what performance.now() reads. */
  now(): number {
    return this.time;
  }

  /** What Date.now() reads. */
  wallNow(): number {
    return WALL_EPOCH - GO_AT + this.time;
  }

  setTimeout(callback: () => void, ms: unknown): TimerHandle {
    return this.add(callback, delayOf(ms), undefined);
  }

  setInterval(callback: () => void, ms: unknown): TimerHandle {
    const delay = Math.max(1, delayOf(ms));
    return this.add(callback, delay, delay);
  }

  clear(handle: unknown): void {
    const id = typeof handle === "number" ? handle : handle instanceof TimerHandle ? handle.id : Number(handle);
    const timer = this.timers.get(id);
    if (!timer) return;
    timer.active = false;
    this.timers.delete(id);
  }

  setReferenced(id: number, referenced: boolean): void {
    const timer = this.timers.get(id);
    if (timer) timer.referenced = referenced;
    this.kick();
  }

  isReferenced(id: number): boolean {
    return this.timers.get(id)?.referenced ?? false;
  }

  refresh(id: number): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    timer.active = false;
    const fresh = { ...timer, due: this.time + timer.delay, seq: this.seq++, active: true };
    this.timers.set(id, fresh);
    this.enqueue(fresh);
  }

  /** Timers waiting to run, for diagnostics. */
  pending(): number {
    return this.timers.size;
  }

  /**
   * The replay starts: time jumps to `GO_AT` (timers due before then run at `GO_AT`, in order) and
   * the clock switches to `mode`. Returns false when startup already took longer than `GO_AT`.
   */
  go(mode: ClockMode): boolean {
    const onTime = this.time <= GO_AT;
    this.time = Math.max(this.time, GO_AT);
    this.mode = mode;
    this.rebase();
    this.kick();
    return onTime;
  }

  /**
   * Stops time at `ms` from now: timers due by then run, later ones wait for `release()`.
   * Resolves once every timer due by the limit has run and no real request is in flight.
   */
  hold(ms = 0): Promise<void> {
    this.limit = this.time + ms;
    const settled = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.kick();
    return settled;
  }

  release(): void {
    this.limit = Number.POSITIVE_INFINITY;
    this.rebase();
    this.kick();
  }

  get holding(): boolean {
    return this.limit !== Number.POSITIVE_INFINITY;
  }

  private add(callback: () => void, delay: number, every: number | undefined): TimerHandle {
    const id = this.nextId++;
    const timer: Timer = {
      id,
      due: this.time + delay,
      seq: this.seq++,
      callback,
      every,
      delay,
      referenced: true,
      active: true,
    };
    this.timers.set(id, timer);
    this.enqueue(timer);
    this.kick();
    return new TimerHandle(this, id);
  }

  private enqueue(timer: Timer): void {
    // Sorted by due time, then by creation: a binary search for the insertion point.
    let low = 0;
    let high = this.queue.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const other = this.queue[middle]!;
      if (other.due < timer.due || (other.due === timer.due && other.seq < timer.seq)) low = middle + 1;
      else high = middle;
    }
    this.queue.splice(low, 0, timer);
  }

  private head(): Timer | undefined {
    while (this.queue.length && !this.queue[0]!.active) this.queue.shift();
    return this.queue[0];
  }

  private rebase(): void {
    this.realBase = this.real.now();
    this.virtualBase = this.time;
  }

  private kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.wake !== undefined) {
      this.real.clearTimeout(this.wake);
      this.wake = undefined;
    }
    this.real.setImmediate(() => this.pump());
  }

  private later(ms: number): void {
    this.scheduled = true;
    this.wake = this.real.setTimeout(() => {
      this.wake = undefined;
      this.pump();
    }, ms);
  }

  /** Runs the next due timer, if time may move to it, then comes back on the next turn. */
  private pump(): void {
    this.scheduled = false;
    if (this.real.busy()) {
      this.later(1);
      return;
    }
    const next = this.head();
    if (!next || next.due > this.limit) {
      if (this.waiters.length && this.limit !== Number.POSITIVE_INFINITY) {
        this.time = Math.max(this.time, this.limit);
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
      }
      return;
    }
    if (this.mode === "paced") {
      const reachable = this.virtualBase + (this.real.now() - this.realBase);
      if (next.due > reachable) {
        this.later(Math.ceil(next.due - reachable));
        return;
      }
    }
    this.queue.shift();
    this.time = Math.max(this.time, next.due);
    if (next.every !== undefined) {
      const again = { ...next, due: this.time + next.every, seq: this.seq++ };
      next.active = false;
      this.timers.set(next.id, again);
      this.enqueue(again);
    } else {
      next.active = false;
      this.timers.delete(next.id);
    }
    try {
      next.callback();
    } catch (error) {
      // As an uncaught exception from a real timer would surface.
      this.real.setImmediate(() => {
        throw error;
      });
    }
    this.kick();
  }
}

function delayOf(ms: unknown): number {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The clock installed in this process, if any. */
export function installedClock(): VirtualClock | undefined {
  return (globalThis as Record<symbol, unknown>)[CLOCK_KEY] as VirtualClock | undefined;
}

/** A global `setTimeout`-shaped function over one of the clock's schedulers. */
function bind(schedule: (callback: () => void, ms: unknown) => TimerHandle) {
  return (callback: unknown, ms?: unknown, ...args: unknown[]) => {
    if (typeof callback !== "function") throw new TypeError("The callback must be a function");
    return schedule(() => callback(...args), ms);
  };
}

/** Replaces the process's timers and clocks with `clock`'s. */
export function install(clock: VirtualClock): void {
  const global = globalThis as Record<string | symbol, unknown>;
  global[CLOCK_KEY] = clock;
  global.setTimeout = bind((callback, ms) => clock.setTimeout(callback, ms));
  global.setInterval = bind((callback, ms) => clock.setInterval(callback, ms));
  global.clearTimeout = (handle: unknown) => clock.clear(handle);
  global.clearInterval = (handle: unknown) => clock.clear(handle);
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.wallNow());
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return clock.wallNow();
    }
  }
  global.Date = VirtualDate;
  performance.now = () => clock.now();
}
