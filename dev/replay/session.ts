/**
 * Reads a recorded pi session and turns its active branch into a replay script.
 *
 * A session file is JSON lines: a `session` header, then entries linked by `id`/`parentId`. The
 * active conversation is the path from the last entry back to a root. Along that path, user
 * prompts, assistant messages and tool results become steps; other entries (model and thinking
 * level changes, custom entries, context edits, labels, system messages) are not replayed.
 *
 * Numbering is global over the path, so `turn 3`, `message 7` and `tool 12` name the same thing
 * whether or not earlier turns are replayed or loaded as history:
 * - a turn is a prompt that starts a run; a prompt sent while tools ran (it follows a tool result)
 *   is a steer and belongs to the run it interrupts;
 * - messages are the assistant messages, in order, without the empty `error` messages a failed
 *   request leaves before pi retries it;
 * - tools are the tool calls of those messages, in order.
 *
 * Compaction: the live replay starts at the first prompt after the last compaction on the path.
 * Everything before it is history, written verbatim into the replay's session so pi shows it as a
 * resumed session would. Replaying across a compaction would need pi to compact at the same point.
 *
 * Pure: no I/O.
 */

export interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: RecordedMessage;
  [key: string]: unknown;
}

export interface RecordedMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  durationMs?: number;
  stopReason?: string;
  errorMessage?: string;
  usage?: { output?: number; [key: string]: unknown };
  model?: string;
  provider?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolResult {
  entryId: string;
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details: unknown;
  isError: boolean;
  durationMs: number | undefined;
}

export interface ToolCallRef {
  /** 1-based over the path. */
  index: number;
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  message: number;
  turn: number;
  result: ToolResult | undefined;
}

export interface PromptStep {
  kind: "prompt";
  entryId: string;
  turn: number;
  steer: boolean;
  content: unknown;
  /** The prompt's text, for listings. */
  text: string;
  /** Milliseconds between the end of the previous message and this prompt. */
  gapMs: number;
  live: boolean;
}

export interface AssistantStep {
  kind: "assistant";
  entryId: string;
  /** 1-based over the path. */
  index: number;
  turn: number;
  message: RecordedMessage;
  blocks: ContentBlock[];
  durationMs: number;
  calls: ToolCallRef[];
  live: boolean;
}

export type Step = PromptStep | AssistantStep;

export interface Skipped {
  entryId: string;
  what: string;
}

export interface Script {
  header: Entry | undefined;
  cwd: string | undefined;
  /** The path's entries before the first live prompt, verbatim. */
  history: Entry[];
  steps: Step[];
  tools: ToolCallRef[];
  toolNames: string[];
  models: string[];
  /** The model of the first live message, else the last one recorded. */
  model: string | undefined;
  thinkingLevel: string | undefined;
  /** Path entries that the live replay leaves out. */
  skipped: Skipped[];
  /** Why the live replay starts where it does. */
  startReason: string;
}

/** Each non-blank line as JSON; a line that does not parse is an error naming its number. */
export function parseSession(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`line ${index + 1}: ${(error as Error).message}`, { cause: error });
    }
    if (entry && typeof entry === "object" && typeof (entry as Entry).type === "string") entries.push(entry as Entry);
  }
  return entries;
}

/** The entries from a root to `leafId` (default: the last entry with an id), in order. */
export function activePath(entries: Entry[], leafId?: string): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entry of entries) if (entry.id && entry.type !== "session") byId.set(entry.id, entry);
  const leaf = leafId ?? entries.findLast((entry) => entry.id && entry.type !== "session")?.id;
  const path: Entry[] = [];
  const seen = new Set<string>();
  for (let id = leaf; id; ) {
    if (seen.has(id)) throw new Error(`parentId cycle at ${id}`);
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    path.push(entry);
    id = entry.parentId ?? undefined;
  }
  return path.toReversed();
}

export function blocksOf(message: RecordedMessage): ContentBlock[] {
  return Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
}

export function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: ContentBlock) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("");
}

function entryTime(entry: Entry): number | undefined {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A failed request pi retries: an `error` message with nothing in it. */
function isRetriedError(message: RecordedMessage): boolean {
  return message.stopReason === "error" && blocksOf(message).length === 0;
}

/**
 * The replay script of a session's active branch. `startTurn` moves the live start later: turns
 * before it load as history too.
 */
export function buildScript(entries: Entry[], options: { startTurn?: number; leafId?: string } = {}): Script {
  const header = entries.find((entry) => entry.type === "session");
  const path = activePath(entries, options.leafId);
  const lastCompaction = path.findLastIndex((entry) => entry.type === "compaction");

  const steps: Step[] = [];
  const tools: ToolCallRef[] = [];
  const results = new Map<string, ToolResult>();
  const skippedAt: Array<Skipped & { position: number }> = [];
  const stepAt = new Map<number, Step>();
  const models: string[] = [];
  let turn = 0;
  let messageIndex = 0;
  let previous: RecordedMessage | undefined;
  let previousEnd: number | undefined;

  for (const [position, entry] of path.entries()) {
    const id = entry.id ?? `#${position}`;
    if (entry.type !== "message" || !entry.message) {
      if (!["model_change", "thinking_level_change", "label", "session_info"].includes(entry.type))
        skippedAt.push({ position, entryId: id, what: entry.type });
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      const steer = previous?.role === "toolResult";
      if (!steer) turn += 1;
      const at = message.timestamp ?? entryTime(entry);
      const step: PromptStep = {
        kind: "prompt",
        entryId: id,
        turn: Math.max(turn, 1),
        steer,
        content: message.content,
        text: promptText(message.content),
        gapMs: at !== undefined && previousEnd !== undefined ? Math.max(0, at - previousEnd) : 0,
        live: false,
      };
      steps.push(step);
      stepAt.set(position, step);
      previousEnd = at;
    } else if (message.role === "assistant") {
      if (isRetriedError(message)) {
        skippedAt.push({ position, entryId: id, what: "empty error message" });
        continue;
      }
      messageIndex += 1;
      const start = message.timestamp ?? entryTime(entry);
      const end = entryTime(entry);
      const durationMs =
        message.durationMs ?? (start !== undefined && end !== undefined ? Math.max(0, end - start) : 0);
      const blocks = blocksOf(message);
      const step: AssistantStep = {
        kind: "assistant",
        entryId: id,
        index: messageIndex,
        turn: Math.max(turn, 1),
        message,
        blocks,
        durationMs,
        calls: [],
        live: false,
      };
      for (const block of blocks) {
        if (block.type !== "toolCall" || !block.id) continue;
        const call: ToolCallRef = {
          index: tools.length + 1,
          id: block.id,
          name: block.name ?? "unknown",
          arguments: block.arguments ?? {},
          message: messageIndex,
          turn: step.turn,
          result: undefined,
        };
        tools.push(call);
        step.calls.push(call);
      }
      if (message.model && !models.includes(message.model)) models.push(message.model);
      steps.push(step);
      stepAt.set(position, step);
      previousEnd = start !== undefined ? start + durationMs : end;
    } else if (message.role === "toolResult") {
      const callId = message.toolCallId ?? "";
      results.set(callId, {
        entryId: id,
        toolCallId: callId,
        toolName: message.toolName ?? "unknown",
        content: Array.isArray(message.content) ? message.content : [],
        details: message.details,
        isError: message.isError === true,
        durationMs: message.durationMs,
      });
      previousEnd = message.timestamp ?? entryTime(entry) ?? previousEnd;
    } else {
      if (message.role !== "system") skippedAt.push({ position, entryId: id, what: `${message.role} message` });
      continue;
    }
    previous = message;
  }
  for (const call of tools) call.result = results.get(call.id);

  // The live replay starts at a run-starting prompt after the last compaction, and not before `startTurn`.
  const startTurn = options.startTurn ?? 1;
  let livePosition = -1;
  for (const [position, step] of stepAt) {
    if (step.kind !== "prompt" || step.steer || position < lastCompaction || step.turn < startTurn) continue;
    livePosition = position;
    break;
  }
  const startReason =
    livePosition === -1
      ? "nothing to replay"
      : startTurn > 1 && (stepAt.get(livePosition) as PromptStep).turn === startTurn
        ? `--start turn:${startTurn}`
        : lastCompaction >= 0
          ? `the last compaction (${path[lastCompaction]?.id})`
          : "the first prompt";
  const history = livePosition === -1 ? path : path.slice(0, livePosition);
  for (const [position, step] of stepAt) step.live = livePosition !== -1 && position >= livePosition;
  const skipped =
    livePosition === -1
      ? []
      : skippedAt.filter((skip) => skip.position >= livePosition).map(({ entryId, what }) => ({ entryId, what }));

  const firstLive = steps.find((step): step is AssistantStep => step.kind === "assistant" && step.live);
  const thinking = path.findLast((entry) => entry.type === "thinking_level_change");
  return {
    header,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
    history,
    steps,
    tools,
    toolNames: [...new Set(tools.map((call) => call.name))],
    models,
    model: firstLive?.message.model ?? models.at(-1),
    thinkingLevel: typeof thinking?.thinkingLevel === "string" ? thinking.thinkingLevel : undefined,
    skipped,
    startReason,
  };
}

export function liveSteps(script: Script): Step[] {
  return script.steps.filter((step) => step.live);
}

export function assistantSteps(script: Script): AssistantStep[] {
  return script.steps.filter((step): step is AssistantStep => step.kind === "assistant");
}

/** The responseId a replayed message carries, so the next request can tell where the replay is. */
export const RESPONSE_PREFIX = "replay:";

export function responseIdOf(index: number): string {
  return `${RESPONSE_PREFIX}${index}`;
}

/**
 * The recorded message that answers a request with these `messages`: the live message after the
 * last replayed one in the request's context, else the first live one. Derived from the context
 * alone, so a retried request gets the same answer, except that an error message already emitted
 * (`emittedErrors`) is passed over: pi drops a failed message from the context before it retries.
 */
export function nextAssistant(
  script: Script,
  messages: ReadonlyArray<{ role?: string; responseId?: unknown }>,
  emittedErrors: ReadonlySet<number> = new Set(),
): AssistantStep | undefined {
  let last = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.responseId !== "string") continue;
    if (!message.responseId.startsWith(RESPONSE_PREFIX)) continue;
    const index = Number(message.responseId.slice(RESPONSE_PREFIX.length));
    if (Number.isInteger(index)) last = Math.max(last, index);
  }
  return assistantSteps(script).find(
    (step) => step.live && step.index > last && !(step.message.stopReason === "error" && emittedErrors.has(step.index)),
  );
}

/** The prompt that must have been sent before `step` is answered: the last prompt before it in the script. */
export function promptBefore(script: Script, step: AssistantStep): PromptStep | undefined {
  const position = script.steps.indexOf(step);
  return script.steps.slice(0, position).findLast((candidate): candidate is PromptStep => candidate.kind === "prompt");
}

/** The prompt that follows `step` directly when it is a steer, sent while `step`'s tools run. */
export function steerAfter(script: Script, step: AssistantStep): PromptStep | undefined {
  const next = script.steps[script.steps.indexOf(step) + 1];
  return next?.kind === "prompt" && next.steer ? next : undefined;
}

function short(text: string, width = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? "untimed" : `${(ms / 1000).toFixed(1)}s`;
}

/** A one-screen outline of the script, for choosing stop points. */
export function outline(script: Script): string {
  const lines: string[] = [];
  const live = liveSteps(script);
  lines.push(`cwd: ${script.cwd ?? "(none)"}`);
  lines.push(`models: ${script.models.join(", ") || "(none)"}; thinking: ${script.thinkingLevel ?? "(unset)"}`);
  lines.push(`tools: ${script.toolNames.join(", ") || "(none)"}`);
  lines.push(`live from: ${script.startReason}; history entries: ${script.history.length}`);
  if (script.skipped.length) {
    const counts = new Map<string, number>();
    for (const skip of script.skipped) counts.set(skip.what, (counts.get(skip.what) ?? 0) + 1);
    lines.push(`not replayed: ${[...counts].map(([what, count]) => `${count} ${what}`).join(", ")}`);
  }
  for (const step of script.steps) {
    const mark = step.live || !live.length ? "" : " (history)";
    if (step.kind === "prompt") {
      lines.push(`${step.steer ? "  steer" : `turn ${step.turn}`}${mark}: ${short(step.text)}`);
      continue;
    }
    const kinds = step.blocks.map((block) => {
      if (block.type === "thinking") return `thinking ${block.thinking?.length ?? 0}c`;
      if (block.type === "text") return `text ${block.text?.length ?? 0}c`;
      return block.type === "toolCall" ? "" : block.type;
    });
    const summary = kinds.filter(Boolean).join(", ");
    const stop = step.message.stopReason && step.message.stopReason !== "toolUse" ? ` ${step.message.stopReason}` : "";
    lines.push(`  message ${step.index}${mark}: ${seconds(step.durationMs)}${summary ? `, ${summary}` : ""}${stop}`);
    for (const call of step.calls) {
      const result = call.result;
      const status = !result ? " (no result)" : result.isError ? " failed" : "";
      lines.push(
        `    tool ${call.index} ${call.name} ${call.id}: ${seconds(result?.durationMs)}${status}  ${short(JSON.stringify(call.arguments), 50)}`,
      );
    }
  }
  return lines.join("\n");
}
