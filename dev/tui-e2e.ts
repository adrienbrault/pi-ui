/**
 * End-to-end check of pi-prism in a real pi TUI, driven through tmux.
 *
 * Synthetic sessions are restored so no model turn is needed. The pane is read
 * as text and SGR mouse sequences are injected as literal input, which is what
 * a terminal would send. The scenarios cover:
 *
 * - A full screen of recent calls retains complete previews.
 * - 7 calls: the decay ladder, the hover chip, click expansion, inert rows.
 * - 12 calls: rows past FOLD_DISTANCE collapse into one summary; the summary
 *   opens its members; a member then expands its own body.
 * - A delegated tool stays visible while an untimed failure joins its group.
 * - Thinking followed by work: the thinking run decays on the same ladder, keeps
 *   a tail, and still opens all the way on click.
 * - Many old thoughts: the folded run becomes one `Thought N times` summary
 *   (untimed thoughts read as a count; timed ones as `Thought for 12s`).
 * - Thoughts and commands: both fold into one shared summary that opens both.
 *
 * Run: bun run e2e
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOCKET = `prism-e2e-${process.pid}`;
const SESSION = "prism-e2e";
const WIDTH = 140;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

type Entry = Record<string, unknown>;

function writeSession(path: string, entries: Entry[], history = true): void {
  if (history) {
    const last = entries.at(-1)!;
    const message = last.message as Record<string, unknown>;
    const rows = Array.from({ length: 110 }, (_, i) => "Transcript continuation " + i);
    entries.push({
      ...last, id: "scrollback", parentId: last.id,
      message: { ...message, content: [{ type: "text", text: rows.join("\n\n") }] },
    });
  }
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function fixture(path: string, callCount: number, overrides: { name?: string; error?: string; output?: string }[] = [], history = true): void {
  const now = Date.now();
  const entries: Entry[] = [];
  let parentId: string | null = null;
  const add = (entry: Entry): void => {
    entries.push(entry);
    parentId = String(entry.id);
  };
  const message = (id: string, timestamp: number, body: Record<string, unknown>): void => {
    add({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message: body });
  };
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
  };

  add({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date(now).toISOString(), cwd: ROOT });
  add({ type: "model_change", id: "model", parentId: null, timestamp: new Date(now).toISOString(), provider: "flan", modelId: "deepseek-v4.1-flash-1017" });
  add({ type: "thinking_level_change", id: "thinking", parentId, timestamp: new Date(now).toISOString(), thinkingLevel: "medium" });
  message("user", now, { role: "user", content: [{ type: "text", text: `Run ${NUMBER_WORDS[callCount] ?? callCount} commands.` }], timestamp: now });

  const calls = Array.from({ length: callCount }, (_, index) => ({
    type: "toolCall",
    id: `call-${index}`,
    name: overrides[index]?.name ?? "bash",
    arguments: { command: `echo command-${index}` },
  }));
  message("assistant-calls", now + 1000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "toolUse",
    timestamp: now + 1000,
    usage,
    content: calls,
  });

  for (let index = 0; index < callCount; index += 1) {
    message(`result-${index}`, now + 2000 + index, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: calls[index]!.name,
      isError: !!overrides[index]?.error,
      durationMs: overrides[index]?.error ? undefined : 100 + index,
      timestamp: now + 2000 + index,
      content: [{ type: "text", text: overrides[index]?.error ?? overrides[index]?.output ?? `output ${index} line A\noutput ${index} line B` }],
    });
  }

  message("assistant-done", now + 3000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "stop",
    timestamp: now + 3000,
    usage,
    content: [{ type: "text", text: `All ${NUMBER_WORDS[callCount] ?? callCount} commands finished.` }],
  });

  writeSession(path, entries, history);
}

function tmux(...args: string[]): string {
  const result = Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function capture(): string {
  return tmux("capture-pane", "-p", "-t", SESSION);
}

async function waitFor(text: string, timeoutMs = 15_000, ready = (_pane: string) => true): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = capture();
    if (pane.includes(text) && ready(pane)) return pane;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}\n--- pane ---\n${pane}`);
    await Bun.sleep(200);
  }
}

/** SGR: 35 is motion with no button; 0 press/release is left click. */
function mouse(button: number, column: number, row: number, release = false): void {
  tmux("send-keys", "-l", "-t", SESSION, `\x1b[<${button};${column};${row}${release ? "m" : "M"}`);
}

function rowOf(pane: string, needle: string): number {
  const index = pane.split("\n").findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`row not found: ${needle}`);
  return index + 1;
}

function lineWith(pane: string, needle: string): string {
  return pane.split("\n").find((line) => line.includes(needle)) ?? "";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function count(pane: string, needle: string): number {
  return pane.split("\n").filter((line) => line.includes(needle)).length;
}

function start(sessionPath: string, height: number, budget = 7): void {

  tmux("-f", "/dev/null", "new-session", "-d", "-s", SESSION, "-x", String(WIDTH), "-y", String(height), "-c", ROOT);
  tmux("set", "-g", "extended-keys", "on");
  // Keep pi's startup warning from moving the row between capture and mouse dispatch.
  tmux("set", "-sq", "extended-keys-format", "csi-u");
  // Only pi-prism and an offline stand-in provider load; see dev/e2e-extension.ts.
  const pi = [
    `env PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PRISM_E2E_TAIL=${budget}`,
    "pi --no-extensions --tui-mode fullscreen",
    `-e ${join(ROOT, "dev", "e2e-extension.ts")}`,
    `--session ${sessionPath}`,
  ].join(" ");
  tmux("send-keys", "-t", SESSION, pi, "Enter");
}

async function openHistory(sessionPath: string, height: number): Promise<void> {
  start(sessionPath, height);
  await waitFor("Transcript continuation 109");
  const entries = (await Bun.file(sessionPath).text()).trim().split("\n").map((line) => JSON.parse(line));
  const prompt = entries.find((entry) => entry.message?.role === "user").message.content[0].text;
  for (let step = 0; step < entries.length && !capture().includes(prompt); step++) {
    tmux("send-keys", "-t", SESSION, "C-Up");
    await Bun.sleep(80);
  }
  await waitFor(prompt, 5000, (pane) => !/[│┃]$/m.test(pane));
}

async function decayScenario(sessionPath: string): Promise<void> {
  await openHistory(sessionPath, 45);
  let pane = await waitFor("All four commands finished.", 15_000, (screen) => screen.includes("output 0 line C") && !screen.includes("output 0 line A"));
  const headers = Array.from({ length: 4 }, (_, index) => `echo command-${index}`);
  for (const header of headers) assert(count(pane, header) === 1, `expected exactly one ${header}\n${pane}`);

  const oldestBody = pane.split("\n").filter((line) => line.includes("output 0 line"));
  assert(oldestBody.length === 3 && oldestBody[0]?.includes("line C"), `oldest body should keep three content lines\n${pane}`);

  const newestBody = pane.split("\n").filter((line) => line.includes("output 3 line"));
  assert(newestBody.length === 2, `newest body should keep both lines\n${pane}`);

  // Re-read the row before every mouse event: notices can appear and shift the pane.
  pane = capture();
  mouse(35, 5, rowOf(pane, headers[0] ?? ""));
  await Bun.sleep(400);
  pane = capture();
  const hovered = lineWith(pane, "+ 2 lines");
  assert(hovered.includes("[ click · expand ]"), `header hover should show the action on the footer\n${hovered}\n${pane}`);

  const gap = rowOf(pane, headers[1]!) - 1;
  assert(pane.split("\n")[gap - 1]?.trim() === "", "expected a blank row between commands");
  mouse(35, 5, gap);
  await Bun.sleep(150);
  assert(!capture().includes("[ click"), "the tool spacer must clear the previous hover");
  mouse(0, 5, gap);
  mouse(0, 5, gap, true);
  await Bun.sleep(150);
  assert(!capture().includes("output 0 line A"), "a spacer click must leave the previous tool collapsed");

  pane = capture();
  const clickRow = rowOf(pane, "+ 2 lines");
  mouse(0, 5, clickRow);
  mouse(0, 5, clickRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(pane.includes("output 0 line A") && pane.includes("output 0 line B"), `click should reveal the full body\n${pane}`);

  pane = capture();
  mouse(35, 5, rowOf(pane, headers[3] ?? ""));
  await Bun.sleep(400);
  pane = capture();
  const newestHeader = lineWith(pane, headers[3] ?? "");
  assert(!newestHeader.includes("[ click"), `a row showing its whole body must stay inert\n${newestHeader}\n${pane}`);
}

function thinkingFixture(path: string): void {
  const now = Date.now();
  const entries: Entry[] = [];
  let parentId: string | null = null;
  const add = (entry: Entry): void => {
    entries.push(entry);
    parentId = String(entry.id);
  };
  const message = (id: string, timestamp: number, body: Record<string, unknown>): void => {
    add({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message: body });
  };
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
  };

  add({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date(now).toISOString(), cwd: ROOT });
  add({ type: "model_change", id: "model", parentId: null, timestamp: new Date(now).toISOString(), provider: "flan", modelId: "deepseek-v4.1-flash-1017" });
  add({ type: "thinking_level_change", id: "thinking", parentId, timestamp: new Date(now).toISOString(), thinkingLevel: "medium" });
  message("user", now, { role: "user", content: [{ type: "text", text: "Explain the sky." }], timestamp: now });
  const thoughts = [
    "Thought intro.",
    "SECRET_MIDDLE_CLAUSE about scattering.",
    ...Array.from({ length: 120 }, (_, index) => `scattering detail ${index}`),
    ...Array.from({ length: 8 }, (_, index) => `thought line ${index + 3}`),
  ].join("\n");
  message("assistant-thinking", now + 1000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "toolUse",
    timestamp: now + 1000,
    usage,
    content: [{ type: "thinking", thinking: thoughts }],
  });

  const calls = Array.from({ length: 3 }, (_, index) => ({
    type: "toolCall",
    id: `call-${index}`,
    name: "bash",
    arguments: { command: `echo thought-${index}` },
  }));
  message("assistant-calls", now + 1500, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "toolUse",
    timestamp: now + 1500,
    usage,
    content: calls,
  });

  for (let index = 0; index < calls.length; index += 1) {
    message(`result-${index}`, now + 2000 + index, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "bash",
      isError: false,
      durationMs: 100 + index,
      timestamp: now + 2000 + index,
      content: [{ type: "text", text: `thought output ${index}` }],
    });
  }

  message("assistant-done", now + 3000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "stop",
    timestamp: now + 3000,
    usage,
    content: [{ type: "thinking", thinking: "Check the short thought." }, { type: "text", text: "The sky is blue." }],
  });

  writeSession(path, entries);
}

function thinkingFoldFixture(path: string): void {
  const now = Date.now();
  const entries: Entry[] = [];
  let parentId: string | null = null;
  const add = (entry: Entry): void => {
    entries.push(entry);
    parentId = String(entry.id);
  };
  const message = (id: string, timestamp: number, body: Record<string, unknown>): void => {
    add({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message: body });
  };
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
  };

  add({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date(now).toISOString(), cwd: ROOT });
  add({ type: "model_change", id: "model", parentId: null, timestamp: new Date(now).toISOString(), provider: "flan", modelId: "deepseek-v4.1-flash-1017" });
  add({ type: "thinking_level_change", id: "thinking", parentId, timestamp: new Date(now).toISOString(), thinkingLevel: "medium" });
  message("user", now, { role: "user", content: [{ type: "text", text: "Fold the old thoughts." }], timestamp: now });

  for (let index = 0; index < 20; index += 1) {
    message(`assistant-${index}`, now + 1000 + index, {
      role: "assistant",
      api: "openai-completions",
      provider: "flan",
      model: "deepseek-v4.1-flash-1017",
      stopReason: "stop",
      timestamp: now + 1000 + index,
      usage,
      content: [{ type: "thinking", thinking: `thought old-${index}` }],
    });
  }

  message("assistant-done", now + 4000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "stop",
    timestamp: now + 4000,
    usage,
    content: [{ type: "text", text: "Fold done." }],
  });

  writeSession(path, entries);
}

async function thinkingFoldScenario(sessionPath: string): Promise<void> {
  await openHistory(sessionPath, 50);
  let pane = await waitFor("Fold done.");
  await Bun.sleep(600);
  pane = capture();
  assert(count(pane, "Thought 16 times") === 1, `old thoughts should fold into one summary\n${pane}`);
  assert(!pane.includes("thought old-0"), `the oldest folded thought leaked\n${pane}`);
  assert(!pane.includes("thought old-11"), `the newest folded thought leaked\n${pane}`);
  assert(pane.includes("thought old-19"), `the newest thought should survive\n${pane}`);

  pane = capture();
  const summaryRow = rowOf(pane, "Thought 16 times");
  mouse(0, 5, summaryRow);
  mouse(0, 5, summaryRow, true);
  await Bun.sleep(500);
  pane = capture();
  assert(pane.includes("thought old-3"), `the thought summary should open its members\n${pane}`);
}

function combinedFoldFixture(path: string): void {
  const now = Date.now();
  const entries: Entry[] = [];
  let parentId: string | null = null;
  const add = (entry: Entry): void => {
    entries.push(entry);
    parentId = String(entry.id);
  };
  const message = (id: string, timestamp: number, body: Record<string, unknown>): void => {
    add({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message: body });
  };
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 17,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
  };

  add({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date(now).toISOString(), cwd: ROOT });
  add({ type: "model_change", id: "model", parentId: null, timestamp: new Date(now).toISOString(), provider: "flan", modelId: "deepseek-v4.1-flash-1017" });
  add({ type: "thinking_level_change", id: "thinking", parentId, timestamp: new Date(now).toISOString(), thinkingLevel: "medium" });
  message("user", now, { role: "user", content: [{ type: "text", text: "Run the long chain." }], timestamp: now });

  for (let index = 0; index < 3; index += 1) {
    message(`thought-${index}`, now + 1000 + index, {
      role: "assistant",
      api: "openai-completions",
      provider: "flan",
      model: "deepseek-v4.1-flash-1017",
      stopReason: "stop",
      timestamp: now + 1000 + index,
      durationMs: 1,
      usage,
      content: [{ type: "thinking", thinking: index === 1 ? [...Array.from({ length: 20 }, (_, i) => `ordered detail ${i}`), "thought combo-1"].join("\n") : `**thought combo-${index}**` }],
    });
  }

  const calls = Array.from({ length: 16 }, (_, index) => ({
    type: "toolCall",
    id: `call-${index}`,
    name: "bash",
    arguments: { command: `echo combo-${index}` },
  }));
  message("assistant-calls", now + 1500, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "toolUse",
    timestamp: now + 1500,
    usage,
    content: calls,
  });
  for (let index = 0; index < calls.length; index += 1) {
    message(`result-${index}`, now + 2000 + index, {
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "bash",
      isError: false,
      durationMs: 100,
      timestamp: now + 2000 + index,
      content: [{ type: "text", text: `combo output ${index}` }],
    });
  }

  message("assistant-done", now + 4000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "stop",
    timestamp: now + 4000,
    usage,
    content: [{ type: "text", text: "Chain done." }],
  });

  writeSession(path, entries);
}

async function combinedFoldScenario(sessionPath: string): Promise<void> {
  await openHistory(sessionPath, 100);
  let pane = await waitFor("Chain done.");
  await Bun.sleep(600);
  pane = capture();
  assert(lineWith(pane, "Thought 3 times").includes("ran 12 shell commands"), `thoughts and commands should share one summary\n${pane}`);
  assert(lineWith(pane, "Thought 3 times").includes("1.0s"), "mixed group should span the first thought through the last folded result");
  assert(lineWith(pane, "Thought 3 times").includes("147 out / 48 in tokens"), "fold should total three thoughts, eight invocations and eight results");
  assert(!pane.includes("echo combo-0 ·"), `the oldest command leaked\n${pane}`);
  assert(pane.includes("echo combo-12 ·"), `the newest surviving command should stay\n${pane}`);

  pane = capture();
  let summaryRow = rowOf(pane, "Thought 3 times");
  mouse(35, 5, summaryRow);
  await Bun.sleep(400);
  pane = capture();
  summaryRow = rowOf(pane, "Thought 3 times");
  assert(lineWith(pane, "Thought 3 times").includes("▸"), `hover must not open the group\n${pane}`);
  assert((pane.split("\n")[summaryRow] ?? "").trim() === "", `hover must not consume the gap below the summary\n${pane}`);

  mouse(35, 5, summaryRow + 1);
  await Bun.sleep(150);
  assert(!capture().includes("[ click"), "entering the blank row must clear the chip immediately");
  mouse(0, 5, summaryRow + 1);
  mouse(0, 5, summaryRow + 1, true);
  await Bun.sleep(150);
  assert(!capture().includes("echo combo-0 ·"), "clicking the gap must leave the group closed");

  pane = capture();
  mouse(0, 5, summaryRow);
  mouse(0, 5, summaryRow, true);
  await Bun.sleep(500);
  pane = capture();
  const openedRow = rowOf(pane, "Thought 3 times");
  const summaryColumn = lineWith(pane, "Thought 3 times").search(/\S/);
  const members = [
    ...Array.from({ length: 3 }, (_, i) => `thought combo-${i}`),
    ...Array.from({ length: 12 }, (_, i) => `echo combo-${i} ·`),
  ];
  for (const [index, member] of members.entries()) {
    const line = pane.split("\n")[openedRow + index] ?? "";
    assert(line.includes(member) && line.search(/\S/) === summaryColumn + 2, `expected consecutive indented member ${member}\n${pane}`);
  }
  assert(!pane.includes("**thought combo-"), "revealed thoughts should render Markdown emphasis");
  assert(lineWith(pane, "echo combo-12 ·").search(/\S/) === summaryColumn, `a surviving tool should align with the summary\n${pane}`);

  mouse(35, 5, rowOf(pane, "thought combo-0"));
  await Bun.sleep(200);
  pane = capture();
  assert(!lineWith(pane, "thought combo-0").includes("[ click"), `fully visible anchor thought should clear the summary hover\n${pane}`);
  const excerpt = rowOf(pane, "thought combo-1");
  mouse(35, 5, excerpt);
  await Bun.sleep(200);
  assert(lineWith(capture(), "thought combo-1").includes("[ click · expand ]"), "an expandable inline excerpt should show its action");
  mouse(0, 5, excerpt);
  mouse(0, 5, excerpt, true);
  pane = await waitFor("ordered detail 0");
  const first = rowOf(pane, "ordered detail 0");
  for (let i = 0; i < 20; i++) {
    assert(pane.split("\n")[first - 1 + i]?.trim() === `ordered detail ${i}`, "expanded thought should keep source order");
  }
  assert(rowOf(pane, "thought combo-1") === first + 20 && rowOf(pane, "thought combo-2") === first + 21, "the final sentence and following sibling should retain their place");
}

async function foldScenario(sessionPath: string): Promise<void> {
  await openHistory(sessionPath, 60);
  let pane = await waitFor("All twelve commands finished.");
  await Bun.sleep(600);
  pane = capture();

  const folded = Array.from({ length: 8 }, (_, index) => `echo command-${index} ·`);
  const survivors = Array.from({ length: 4 }, (_, index) => `echo command-${index + 8} ·`);
  assert(pane.includes("Ran 8 shell commands"), `folded rows should become one summary\n${pane}`);
  for (const header of folded) assert(count(pane, header) === 0, `folded member leaked: ${header}\n${pane}`);
  for (const header of survivors) assert(count(pane, header) === 1, `surviving row missing: ${header}\n${pane}`);

  pane = capture();
  mouse(35, 5, rowOf(pane, "Ran 8 shell commands"));
  await Bun.sleep(400);
  pane = capture();
  assert(lineWith(pane, "Ran 8 shell commands").includes("[ click · expand ]"), `summary hover should show its action\n${pane}`);

  pane = capture();
  const summaryRow = rowOf(pane, "Ran 8 shell commands");
  mouse(0, 5, summaryRow);
  mouse(0, 5, summaryRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(lineWith(pane, "Ran 8 shell commands").includes("[ click · collapse ]"), "open group should show its collapse action");
  for (const header of folded) assert(count(pane, header) === 1, `opened group should reveal ${header}\n${pane}`);

  pane = capture();
  mouse(35, 5, rowOf(pane, folded[0] ?? ""));
  await Bun.sleep(400);
  pane = capture();
  assert(lineWith(pane, folded[0] ?? "").includes("[ click · expand ]"), `member hover should show its action\n${pane}`);

  pane = capture();
  const memberRow = rowOf(pane, folded[0] ?? "");
  mouse(0, 5, memberRow);
  mouse(0, 5, memberRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(pane.includes("output 0 line A") && pane.includes("output 0 line B"), `member click should reveal its body\n${pane}`);

  mouse(35, 5, rowOf(pane, folded[1] ?? ""));
  await Bun.sleep(150);
  assert(lineWith(capture(), "output 0 line B").includes("[ click · collapse ]"), "open member should keep its collapse action after the pointer leaves");
  const secondRow = rowOf(pane, folded[1] ?? "");
  mouse(0, 5, secondRow);
  mouse(0, 5, secondRow, true);
  pane = await waitFor("output 1 line A", 2000);
  assert(pane.includes("output 1 line B"), `a later member should reveal its whole body\n${pane}`);
  const column = lineWith(pane, "Ran 8 shell commands").search(/\S/);
  assert(lineWith(pane, folded[0]!).search(/\S/) === column + 2, `the anchor tool should be indented\n${pane}`);
  assert(lineWith(pane, "output 1 line B").search(/\S/) === column + 6, `tool output should nest under its member\n${pane}`);
}

async function thinkingScenario(sessionPath: string): Promise<void> {
  await openHistory(sessionPath, 65);
  await waitFor("The sky is blue.");
  let pane = await waitFor("✻ think", 5_000);
  const tail = pane.split("\n").filter((line) => line.includes("thought line "));
  assert(tail.length >= 1, `thinking should keep a decayed tail, not vanish\n${pane}`);
  assert(pane.includes("thought line 10"), `the newest thought lines should survive\n${pane}`);
  assert(/\+ \d+ lines?/.test(pane), `thinking should say how much it hid\n${pane}`);
  assert(!pane.includes("SECRET_MIDDLE_CLAUSE"), `collapsed thinking should keep only its tail\n${pane}`);

  pane = capture();
  const hoverRow = pane.split("\n").findIndex(line => /^\s*\+ \d+ lines?\s*$/.test(line)) + 1;
  mouse(35, 5, hoverRow);
  await Bun.sleep(400);
  pane = capture();
  assert(/\+ \d+ lines? \[ click · expand \]/.test(pane), `thinking hover should show the expand chip\n${pane}`);

  const spacerRow = rowOf(pane, "✻ think") - 1;
  assert(pane.split("\n")[spacerRow - 1]?.trim() === "", "expected a blank before the thinking block");
  mouse(35, 5, spacerRow);
  await Bun.sleep(150);
  assert(!capture().includes("[ click"), "the thinking spacer must clear the previous hover");
  mouse(0, 5, spacerRow);
  mouse(0, 5, spacerRow, true);
  await Bun.sleep(150);
  assert(!capture().includes("SECRET_MIDDLE_CLAUSE"), "a spacer click must leave the thought collapsed");

  pane = capture();
  const headerRow = rowOf(pane, "✻ think");
  mouse(0, 5, headerRow);
  mouse(0, 5, headerRow, true);
  await Bun.sleep(400);
  pane = capture();
  for (let i = 0; i < 60 && !pane.includes("scattering detail 65"); i++) {
    mouse(pane.includes("thought line 10") ? 64 : 65, 20, 15);
    await Bun.sleep(60);
    pane = capture();
  }
  assert(pane.includes("scattering detail 65"), `expected to scroll through expanded thinking\n${pane}`);
  assert(!pane.includes("thought line 10"), "the natural collapse footer must be off screen");
  const collapseRow = rowOf(pane, "[ click · collapse ]");
  mouse(0, 5, collapseRow);
  mouse(0, 5, collapseRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(!pane.includes("scattering detail 65"), `pinned click should collapse thinking again\n${pane}`);
  assert(pane.includes("✻ think"), `collapsed thinking must keep its marker\n${pane}`);

  pane = await waitFor("Check the short thought.", 5000, (screen) => !/[│┃]$/m.test(screen));
  const shortTextRow = rowOf(pane, "Check the short thought.");
  const shortHeader = lineWith(pane, "Check the short thought.").includes("✻ think") ? shortTextRow : shortTextRow - 1;
  const styledHeader = () => tmux("capture-pane", "-e", "-p", "-t", SESSION).split("\n")[shortHeader - 1];
  const beforeHover = styledHeader();
  for (const row of [shortHeader, shortHeader + 1]) {
    mouse(35, 5, row);
    await Bun.sleep(150);
    assert(styledHeader() === beforeHover, "hovering a fully visible thought should leave its header and colors unchanged");
  }
  mouse(0, 5, shortHeader);
  mouse(0, 5, shortHeader, true);
  await Bun.sleep(150);
  assert(styledHeader() === beforeHover, "clicking a fully visible thought should leave it inert");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-prism-e2e-"));
  try {
    const live = join(dir, "visible.jsonl");
    const longPreview = { output: Array.from({ length: 40 }, (_, i) => "animated line " + i).join("\n") };
    fixture(live, 6, [{}, longPreview, longPreview], false);
    start(live, 100, 8);
    await waitFor("All six commands finished.");
    await Bun.sleep(350);
    const visible = capture();
    assert(visible.includes("Ran 1 shell command") && !visible.includes("output 0 line A") && visible.includes("output 5 line B"), `visible history should age while the newest preview stays open
${visible}`);
    tmux("send-keys", "-t", SESSION, "new run for animation", "Enter");
    await waitFor("Ran 1 shell command", 8000, screen => {
      const start = screen.indexOf("echo command-1");
      const end = screen.indexOf("echo command-2");
      if (start < 0 || end < start) return false;
      const folding = screen.slice(start, end);
      return folding.includes("animated line 39") && !folding.includes("+ 37 lines");
    });
    await waitFor("Ran 2 shell commands", 8000);
    tmux("kill-server");

    const decay = join(dir, "decay.jsonl");
    fixture(decay, 4, [{ output: ["A","B","C","D","E"].map(letter => "output 0 line " + letter).join("\n") }]);
    await decayScenario(decay);
    console.log("decay ok: three content lines at the oldest, full newest, hover chip and click reveal");

    tmux("kill-server");
    const long = join(dir, "long.jsonl");
    fixture(long, 1, [{ output: Array.from({ length: 160 }, (_, i) => `long output line ${i}.`).join("\n") }]);
    await openHistory(long, 45);
    let pane = await waitFor("+ 154 lines");
    const footer = rowOf(pane, "+ 154 lines");
    mouse(0, 5, footer);
    mouse(0, 5, footer, true);
    await Bun.sleep(250);
    pane = capture();
    for (let i = 0; i < 100 && !pane.includes("long output line 80."); i++) {
      const first = Number(/long output line (\d+)\./.exec(pane)?.[1] ?? 0);
      mouse(first > 80 ? 64 : 65, 20, 15);
      await Bun.sleep(50);
      pane = capture();
    }
    assert(pane.includes("long output line 80.") && !pane.includes("long output line 159."), "expected middle of expanded bash output");
    const pinned = rowOf(pane, "[ click · collapse ]");
    mouse(0, 5, pinned);
    mouse(0, 5, pinned, true);
    await Bun.sleep(200);
    assert(!capture().includes("long output line 80."), "the pinned control should close the block");
    for (let i = 0; i < 60 && !capture().includes("+ 154 lines"); i++) {
      mouse(64, 20, 15);
      await Bun.sleep(50);
    }
    await waitFor("+ 154 lines");
    console.log("long bash output collapses from its pinned viewport control");
    tmux("kill-server");
    const fold = join(dir, "fold.jsonl");
    fixture(fold, 12);
    await foldScenario(fold);
    console.log("fold ok: 8 old rows became one summary; summary opens members; member body expands");

    tmux("kill-server");
    const mixed = join(dir, "delegated-and-failed.jsonl");
    fixture(mixed, 12, [{ name: "custom_review_tool" }, {}, { error: "permission denied\nexit code 2" }]);
    await openHistory(mixed, 65);
    let mixedPane = await waitFor("Ran 7 shell commands", 15_000, (screen) => lineWith(screen, "Ran 7 shell commands").includes("(1 failed)"));
    assert(mixedPane.includes("custom_review_tool"), "the delegated row should keep its own renderer");
    assert(!mixedPane.includes("exit code 2"), "a grouped failure should fold");
    const summary = rowOf(mixedPane, "Ran 7 shell commands");
    mouse(0, 5, summary);
    mouse(0, 5, summary, true);
    mixedPane = await waitFor("echo command-1 ·");
    assert(mixedPane.includes("echo command-3 ·"), "the summary should reveal both successful calls");
    assert(mixedPane.includes("exit code 2"), "opening the group should reveal the failed call");
    console.log("grouped failure count and expanded error verified");

    tmux("kill-server");
    const think = join(dir, "thinking.jsonl");
    thinkingFixture(think);
    await thinkingScenario(think);
    console.log("thinking ok: thinking keeps a decayed tail; click reveals the full thought; second click collapses");

    tmux("kill-server");
    const thinkFold = join(dir, "thinking-fold.jsonl");
    thinkingFoldFixture(thinkFold);
    await thinkingFoldScenario(thinkFold);
    console.log("thinking fold ok: old thoughts became one summary; click opens them");

    tmux("kill-server");
    const combined = join(dir, "combined-fold.jsonl");
    combinedFoldFixture(combined);
    await combinedFoldScenario(combined);
    console.log("combined fold ok: thoughts and commands share one summary and open together");
  } finally {
    try {
      tmux("kill-server");
    } catch {}
  }
}

await main();
