/**
 * Points in a replay, and the progress events the replay extension reports.
 *
 * A stop spec names a point by the script's global numbering (see session.ts):
 * - `turn:N`: turn N has run and pi has settled;
 * - `message:N` or `message:N@P%`: message N has streamed P% of its characters (default 100: it
 *   has finished);
 * - `tool:N` or `tool:ID`, with `:start` (default) or `:end`: tool call N (or the call with that
 *   id) has started, or has returned its result;
 * - `end`: the last turn has run.
 * The extension pauses the replay at the first event that reaches its stop; the driver uses the
 * same test to start a recording.
 *
 * Pure: no I/O.
 */

export type Stop =
  | { kind: "turn"; turn: number }
  | { kind: "message"; message: number; pct: number }
  | { kind: "tool"; tool: number | string; at: "start" | "end" }
  | { kind: "end" };

export type ReplayEvent =
  | { type: "ready" }
  | { type: "prompt"; turn: number; steer: boolean }
  | { type: "message_start"; message: number; turn: number }
  | { type: "progress"; message: number; pct: number; block: number; kind: string }
  | { type: "message_end"; message: number; stopReason: string }
  | { type: "tool_start"; tool: number; id: string; name: string }
  | { type: "tool_end"; tool: number; id: string; name: string; isError: boolean }
  | { type: "settled"; turn: number }
  | { type: "paused"; stop: string }
  | { type: "finished" }
  | { type: "warning"; text: string };

export type TimedEvent = ReplayEvent & { t: number };

function count(text: string | undefined, spec: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`bad stop ${JSON.stringify(spec)}: expected a number from 1`);
  return value;
}

export function parseStop(spec: string): Stop {
  const [kind, rest = ""] = spec.split(/:(.*)/s, 2) as [string, string | undefined];
  if (kind === "end" && !rest) return { kind: "end" };
  if (kind === "turn") return { kind: "turn", turn: count(rest, spec) };
  if (kind === "message") {
    const match = /^(\d+)(?:@(\d+(?:\.\d+)?)%?)?$/.exec(rest);
    if (!match) throw new Error(`bad stop ${JSON.stringify(spec)}: expected message:N or message:N@P%`);
    const pct = match[2] === undefined ? 100 : Number(match[2]);
    if (pct > 100) throw new Error(`bad stop ${JSON.stringify(spec)}: P is a percentage`);
    return { kind: "message", message: count(match[1], spec), pct };
  }
  if (kind === "tool") {
    const match = /^(.+?)(?::(start|end))?$/.exec(rest);
    if (!match?.[1])
      throw new Error(`bad stop ${JSON.stringify(spec)}: expected tool:N or tool:ID, then :start or :end`);
    const tool = /^\d+$/.test(match[1]) ? count(match[1], spec) : match[1];
    return { kind: "tool", tool, at: (match[2] as "start" | "end" | undefined) ?? "start" };
  }
  throw new Error(`bad stop ${JSON.stringify(spec)}: expected turn:N, message:N[@P%], tool:N|ID[:start|:end] or end`);
}

export function formatStop(stop: Stop): string {
  if (stop.kind === "turn") return `turn:${stop.turn}`;
  if (stop.kind === "message")
    return stop.pct === 100 ? `message:${stop.message}` : `message:${stop.message}@${stop.pct}%`;
  if (stop.kind === "tool") return `tool:${stop.tool}:${stop.at}`;
  return "end";
}

export function reached(stop: Stop, event: ReplayEvent): boolean {
  switch (stop.kind) {
    case "turn":
      return event.type === "settled" && event.turn >= stop.turn;
    case "message":
      if (event.type === "message_end") return event.message >= stop.message;
      return (
        event.type === "progress" &&
        stop.pct < 100 &&
        (event.message > stop.message || (event.message === stop.message && event.pct >= stop.pct))
      );
    case "tool": {
      const type = stop.at === "start" ? "tool_start" : "tool_end";
      if (event.type !== type) return false;
      return typeof stop.tool === "number" ? event.tool === stop.tool : event.id === stop.tool;
    }
    case "end":
      return event.type === "finished";
  }
}
