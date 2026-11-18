/**
 * End-to-end check of pi-prism in a real pi TUI, driven through tmux.
 *
 * Synthetic sessions are restored so no model turn is needed. The pane is read
 * as text and SGR mouse sequences are injected as literal input, which is what
 * a terminal would send. Two scenarios:
 *
 * - 7 calls: the decay ladder, the hover chip, click expansion, inert rows.
 * - 12 calls: rows past FOLD_DISTANCE collapse into one summary; the summary
 *   opens its members; a member then expands its own body.
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

function fixture(path: string, callCount: number): void {
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
    name: "bash",
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
      toolName: "bash",
      isError: false,
      durationMs: 100 + index,
      timestamp: now + 2000 + index,
      content: [{ type: "text", text: `output ${index} line A\noutput ${index} line B` }],
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

  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function tmux(...args: string[]): string {
  const result = Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function capture(): string {
  return tmux("capture-pane", "-p", "-t", SESSION);
}

async function waitFor(text: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = capture();
    if (pane.includes(text)) return pane;
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

function start(sessionPath: string, height: number): void {
  tmux("-f", "/dev/null", "new-session", "-d", "-s", SESSION, "-x", String(WIDTH), "-y", String(height), "-c", ROOT);
  tmux("set", "-g", "extended-keys", "on");
  const pi = [
    "env PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1",
    "pi --no-extensions",
    `-e ${join(process.env.HOME ?? "", ".pi/agent/extensions/flan-gateway.ts")}`,
    `-e ${join(ROOT, "packages/pi-prism/extensions/index.ts")}`,
    `--session ${sessionPath}`,
  ].join(" ");
  tmux("send-keys", "-t", SESSION, pi, "Enter");
}

async function decayScenario(sessionPath: string): Promise<void> {
  start(sessionPath, 45);
  let pane = await waitFor("All seven commands finished.");
  const headers = Array.from({ length: 7 }, (_, index) => `echo command-${index}`);
  for (const header of headers) assert(count(pane, header) === 1, `expected exactly one ${header}\n${pane}`);
  assert(pane.includes("command-0 · 2 lines"), "the oldest row should report its hidden line count");

  const oldestBody = pane.split("\n").filter((line) => line.includes("output 0 line"));
  assert(oldestBody.length === 1 && oldestBody[0]?.includes("line B"), `oldest body should be one tail line\n${pane}`);

  const newestBody = pane.split("\n").filter((line) => line.includes("output 6 line"));
  assert(newestBody.length === 2, `newest body should keep both lines\n${pane}`);

  // Re-read the row before every mouse event: notices can appear and shift the pane.
  pane = capture();
  mouse(35, 5, rowOf(pane, headers[0] ?? ""));
  await Bun.sleep(400);
  pane = capture();
  const hovered = lineWith(pane, headers[0] ?? "");
  assert(hovered.includes("[ click · expand ]"), `hover should show the expand chip\n${hovered}\n${pane}`);

  pane = capture();
  const clickRow = rowOf(pane, headers[0] ?? "");
  mouse(0, 5, clickRow);
  mouse(0, 5, clickRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(pane.includes("output 0 line A") && pane.includes("output 0 line B"), `click should reveal the full body\n${pane}`);

  pane = capture();
  mouse(35, 5, rowOf(pane, headers[6] ?? ""));
  await Bun.sleep(400);
  pane = capture();
  const newestHeader = lineWith(pane, headers[6] ?? "");
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
  message("assistant", now + 1000, {
    role: "assistant",
    api: "openai-completions",
    provider: "flan",
    model: "deepseek-v4.1-flash-1017",
    stopReason: "stop",
    timestamp: now + 1000,
    usage,
    content: [
      { type: "thinking", thinking: "Intro words.\nSECRET_MIDDLE_CLAUSE about scattering.\nFinal tail end." },
      { type: "text", text: "The sky is blue." },
    ],
  });

  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function foldScenario(sessionPath: string): Promise<void> {
  start(sessionPath, 60);
  let pane = await waitFor("All twelve commands finished.");

  const folded = Array.from({ length: 4 }, (_, index) => `echo command-${index} ·`);
  const survivors = Array.from({ length: 8 }, (_, index) => `echo command-${index + 4} ·`);
  assert(pane.includes("Ran 4 commands"), `folded rows should become one summary\n${pane}`);
  for (const header of folded) assert(count(pane, header) === 0, `folded member leaked: ${header}\n${pane}`);
  for (const header of survivors) assert(count(pane, header) === 1, `surviving row missing: ${header}\n${pane}`);

  pane = capture();
  mouse(35, 5, rowOf(pane, "Ran 4 commands"));
  await Bun.sleep(400);
  pane = capture();
  assert(lineWith(pane, "Ran 4 commands").includes("[ click · expand ]"), `summary hover should offer expand\n${pane}`);

  pane = capture();
  const summaryRow = rowOf(pane, "Ran 4 commands");
  mouse(0, 5, summaryRow);
  mouse(0, 5, summaryRow, true);
  await Bun.sleep(400);
  pane = capture();
  for (const header of folded) assert(count(pane, header) === 1, `opened group should reveal ${header}\n${pane}`);

  pane = capture();
  mouse(35, 5, rowOf(pane, folded[0] ?? ""));
  await Bun.sleep(400);
  pane = capture();
  assert(lineWith(pane, folded[0] ?? "").includes("[ click · expand ]"), `member hover should offer expand\n${pane}`);

  pane = capture();
  const memberRow = rowOf(pane, folded[0] ?? "");
  mouse(0, 5, memberRow);
  mouse(0, 5, memberRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(pane.includes("output 0 line A") && pane.includes("output 0 line B"), `member click should reveal its body\n${pane}`);
}

async function thinkingScenario(sessionPath: string): Promise<void> {
  start(sessionPath, 40);
  await waitFor("The sky is blue.");
  let pane = await waitFor("✻ think", 5_000);
  assert(!pane.includes("SECRET_MIDDLE_CLAUSE"), `collapsed thinking should keep only its tail\n${pane}`);

  pane = capture();
  const hoverRow = rowOf(pane, "✻ think");
  mouse(35, 5, hoverRow);
  await Bun.sleep(400);
  pane = capture();
  assert(lineWith(pane, "✻ think").includes("[ click · expand ]"), `thinking hover should show the expand chip\n${pane}`);

  pane = capture();
  const expandRow = rowOf(pane, "✻ think");
  mouse(0, 5, expandRow);
  mouse(0, 5, expandRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(pane.includes("SECRET_MIDDLE_CLAUSE"), `click should reveal the full thinking body\n${pane}`);

  pane = capture();
  const collapseRow = rowOf(pane, "Intro words.");
  mouse(0, 5, collapseRow);
  mouse(0, 5, collapseRow, true);
  await Bun.sleep(400);
  pane = capture();
  assert(!pane.includes("SECRET_MIDDLE_CLAUSE"), `second click should collapse thinking again\n${pane}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-prism-e2e-"));
  try {
    const decay = join(dir, "decay.jsonl");
    fixture(decay, 7);
    await decayScenario(decay);
    console.log("decay ok: one tail line at the oldest, full newest, hover chip and click reveal");

    tmux("kill-server");
    const fold = join(dir, "fold.jsonl");
    fixture(fold, 12);
    await foldScenario(fold);
    console.log("fold ok: 4 old rows became one summary; summary opens members; member body expands");

    tmux("kill-server");
    const think = join(dir, "thinking.jsonl");
    thinkingFixture(think);
    await thinkingScenario(think);
    console.log("thinking ok: custom label renders; click reveals the full thought; second click collapses");
  } finally {
    try {
      tmux("kill-server");
    } catch {}
  }
}

await main();
