// oxlint-disable no-await-in-loop -- the driver polls one tick at a time
/**
 * Replays a recorded pi session in real pi, offline, in a tmux pane of its own, and captures it.
 *
 *   bun run replay -- <session.jsonl> [options]
 *
 * pi is the install pinned in pi-ui's devDependencies (or PI_CODING_AGENT_ROOT), loaded with
 * pi-ui and dev/replay/extension.ts only, an empty agent directory, and a session file of its own:
 * nothing reads or writes ~/.pi, and the recorded session is only read.
 *
 * The working directory defaults to an empty temporary directory named like the recorded one, so
 * pi's footer reads sensibly and pi-ui's bash diff hook finds no git work tree to snapshot. With
 * `--cwd`, the replay still shows each command's recorded changes, never the directory's.
 *
 * What does not replay as recorded:
 * - pi's own clocks run on replay time: a running thought's timer, the spinner, and each tool's
 *   duration read the replay's time, so at `--speed N` they read 1/N of the recording. A finished
 *   thought shows its recorded time. While paused, pi-ui's timers and spinners keep moving.
 * - The footer names the `replay` provider's copy of the model; the context bar is out of a very
 *   large window, so pi never compacts mid-replay. Model switches inside the replay are not
 *   applied.
 * - Turns before the last compaction load as history; empty error messages that pi retried, user
 *   `!` commands, custom entries and custom messages are left out (--list counts them).
 * - Tools from extensions the recording had loaded (a todo list, a question prompt) render with
 *   pi's generic renderer, not their own.
 * - A shell command's output streams line by line over its recorded duration; the recording
 *   holds only the final output, not when each line arrived.
 * - A prompt after a tool result is sent as a steer while the tools run, also when the recorded
 *   run was in fact interrupted there.
 *
 * Run with --help for the options.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { piInstallRoot } from "../../design-system/lib/pi.ts";
import { rowOf, tmuxSession } from "../tmux.ts";
import { asciicast, distinct, type Frame, renderGif, renderPng } from "./capture.ts";
import type { ReplayConfig } from "./extension.ts";
import { assistantSteps, buildScript, liveSteps, outline, parseSession, type Script } from "./session.ts";
import { formatStop, parseStop, reached, type Stop, type TimedEvent } from "./stops.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SESSION = "replay";

const HELP = `Usage: bun run replay -- <session.jsonl> [options]

Replays a recorded pi session in pi, offline, and captures the screen.

  --list               print the session's turns, messages and tools, and exit
  --until SPEC         pause there and capture (default: end)
                       turn:N | message:N[@P%] | tool:N|ID[:start|:end] | end
                       A point is reached once it has happened: turn:N when pi settles
                       after turn N, message:N when it has streamed (message:N@0% at its
                       first delta), tool:N when it starts (tool:N:end when it returns).
  --start turn:N       load the turns before N as history and replay from turn N
  --speed N            play N times as fast (default 1)
  --max-gap MS         longest pause between prompts (default 2000)
  --max-wait MS        longest a message or a tool may take, after --speed (default: none)
  --width N --height N pane size (default 120x40)
  --theme dark|light   pi's theme and the render's palette (default dark)
  --cwd DIR            pi's working directory (default: an empty temporary one)
  --hover TEXT         after the pause, move the mouse over the first row with TEXT
  --click TEXT         after the pause, click the first row with TEXT
  --settle MS          wait before each capture and after each action (default 1000)
  --shot FILE.png      a PNG of the final screen
  --ansi FILE          the final screen as ANSI text
  --gif FILE.gif       a GIF from --from (default: pi's first screen) to the pause,
                       and its asciicast next to it as FILE.cast
  --from SPEC          where the GIF starts, reached as --until is
  --fps N              GIF frames per second (default 12)
  --font-size N        render font size in pixels (default 16)
  --timeout S          give up after S seconds (default: 1.5 times the replay's length, plus 60)
  --keep               leave tmux running and keep the work directory
  --help

With no output option, writes a PNG and the ANSI text under tmp/replay-out/.`;

interface Options {
  session: string;
  list: boolean;
  until: Stop;
  from: Stop | undefined;
  startTurn: number | undefined;
  speed: number;
  maxGapMs: number;
  maxWaitMs: number | undefined;
  width: number;
  height: number;
  theme: "dark" | "light";
  cwd: string | undefined;
  actions: Array<{ kind: "hover" | "click"; text: string }>;
  settleMs: number;
  shot: string | undefined;
  ansi: string | undefined;
  gif: string | undefined;
  fps: number;
  fontSize: number;
  timeoutS: number | undefined;
  keep: boolean;
}

function number(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${flag} needs a positive number`);
  return parsed;
}

export function parseOptions(argv: string[]): Options {
  const options: Options = {
    session: "",
    list: false,
    until: { kind: "end" },
    from: undefined,
    startTurn: undefined,
    speed: 1,
    maxGapMs: 2000,
    maxWaitMs: undefined,
    width: 120,
    height: 40,
    theme: "dark",
    cwd: undefined,
    actions: [],
    settleMs: 1000,
    shot: undefined,
    ansi: undefined,
    gif: undefined,
    fps: 12,
    fontSize: 16,
    timeoutS: undefined,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        console.log(HELP);
        process.exit(0);
        break;
      case "--list":
        options.list = true;
        break;
      case "--until":
      case "--to":
        options.until = parseStop(value());
        break;
      case "--from":
        options.from = parseStop(value());
        break;
      case "--start": {
        const stop = parseStop(value());
        if (stop.kind !== "turn") throw new Error("--start takes turn:N");
        options.startTurn = stop.turn;
        break;
      }
      case "--speed":
        options.speed = number(value(), flag);
        break;
      case "--max-gap":
        options.maxGapMs = number(value(), flag);
        break;
      case "--max-wait":
        options.maxWaitMs = number(value(), flag);
        break;
      case "--width":
        options.width = Math.round(number(value(), flag));
        break;
      case "--height":
        options.height = Math.round(number(value(), flag));
        break;
      case "--theme": {
        const theme = value();
        if (theme !== "dark" && theme !== "light") throw new Error("--theme is dark or light");
        options.theme = theme;
        break;
      }
      case "--cwd":
        options.cwd = resolve(value());
        break;
      case "--hover":
      case "--click":
        options.actions.push({ kind: flag.slice(2) as "hover" | "click", text: value() });
        break;
      case "--settle":
        options.settleMs = number(value(), flag);
        break;
      case "--shot":
        options.shot = resolve(value());
        break;
      case "--ansi":
        options.ansi = resolve(value());
        break;
      case "--gif":
        options.gif = resolve(value());
        break;
      case "--fps":
        options.fps = number(value(), flag);
        break;
      case "--font-size":
        options.fontSize = number(value(), flag);
        break;
      case "--timeout":
        options.timeoutS = number(value(), flag);
        break;
      case "--keep":
        options.keep = true;
        break;
      default:
        if (flag.startsWith("-") || options.session) throw new Error(`unknown argument ${flag}\n\n${HELP}`);
        options.session = resolve(flag);
    }
  }
  if (!options.session && !argv.includes("--help")) throw new Error(`a session file is required\n\n${HELP}`);
  return options;
}

/** Whether `stop` names something the live replay will reach. */
export function checkStop(script: Script, stop: Stop, flag: string): void {
  const live = liveSteps(script);
  const fail = (why: string) => {
    throw new Error(`${flag} ${formatStop(stop)}: ${why}; see --list`);
  };
  if (stop.kind === "turn" && !live.some((step) => step.kind === "prompt" && step.turn === stop.turn))
    fail("no such turn in the live replay");
  if (stop.kind === "message" && !assistantSteps(script).some((step) => step.live && step.index === stop.message))
    fail("no such message in the live replay");
  if (stop.kind === "tool") {
    const call = script.tools.find((candidate) =>
      typeof stop.tool === "number" ? candidate.index === stop.tool : candidate.id === stop.tool,
    );
    if (!call || !live.some((step) => step.kind === "assistant" && step.calls.includes(call)))
      fail("no such tool call in the live replay");
  }
}

/** The replay's session file: a fresh header, the history verbatim, then the replay model selected. */
export function replaySession(script: Script, cwd: string, model: string): string {
  const now = new Date().toISOString();
  const lines: object[] = [{ type: "session", version: 3, id: crypto.randomUUID(), timestamp: now, cwd }];
  let parentId: string | null = null;
  for (const entry of script.history) {
    if (entry.type === "session") continue;
    lines.push(entry);
    parentId = entry.id ?? parentId;
  }
  lines.push({
    type: "model_change",
    id: "replay-model",
    parentId,
    timestamp: now,
    provider: "replay",
    modelId: model,
  });
  if (script.thinkingLevel)
    lines.push({
      type: "thinking_level_change",
      id: "replay-thinking",
      parentId: "replay-model",
      timestamp: now,
      thinkingLevel: script.thinkingLevel,
    });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** About how long the live replay takes, in milliseconds of replay time. */
function replayLength(script: Script, options: Options): number {
  const scaled = (ms: number, cap = options.maxWaitMs ?? Number.POSITIVE_INFINITY) => Math.min(ms / options.speed, cap);
  let total = 0;
  for (const step of liveSteps(script)) {
    if (step.kind === "prompt") total += scaled(step.gapMs, options.maxGapMs);
    else
      total += scaled(step.durationMs) + Math.max(0, ...step.calls.map((call) => scaled(call.result?.durationMs ?? 0)));
  }
  return total;
}

function defaultOutputs(options: Options): void {
  if (options.shot || options.ansi || options.gif) return;
  const dir = join(ROOT, "tmp", "replay-out");
  mkdirSync(dir, { recursive: true });
  const stem = `${basename(options.session, ".jsonl")}-${formatStop(options.until).replace(/[^a-z0-9]+/gi, "-")}`;
  options.shot = join(dir, `${stem}.png`);
  options.ansi = join(dir, `${stem}.ans`);
}

export async function replay(options: Options): Promise<{ outputs: string[]; events: TimedEvent[] }> {
  const script = buildScript(parseSession(readFileSync(options.session, "utf8")), { startTurn: options.startTurn });
  if (options.list) {
    console.log(outline(script));
    return { outputs: [], events: [] };
  }
  if (!liveSteps(script).some((step) => step.kind === "prompt"))
    throw new Error("nothing to replay: no prompt on the active branch");
  checkStop(script, options.until, "--until");
  if (options.from) checkStop(script, options.from, "--from");
  defaultOutputs(options);

  // A short path: pi's footer shows the working directory, which lives in here by default.
  const work = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "pi-replay-"));
  const control = join(work, "control");
  const agent = join(work, "agent");
  mkdirSync(control);
  mkdirSync(agent);
  // The startup listing would name the replay's own extension files.
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true }));
  const cwd = options.cwd ?? join(work, basename(script.cwd ?? "") || "project");
  mkdirSync(cwd, { recursive: true });
  const model = script.model ?? "replay";
  const sessionFile = join(work, "session.jsonl");
  writeFileSync(sessionFile, replaySession(script, cwd, model));
  const config: ReplayConfig = {
    session: options.session,
    speed: options.speed,
    maxGapMs: options.maxGapMs,
    ...(options.maxWaitMs ? { maxWaitMs: options.maxWaitMs } : {}),
    ...(options.startTurn ? { startTurn: options.startTurn } : {}),
    until: formatStop(options.until),
    theme: options.theme,
    control,
  };
  writeFileSync(join(work, "config.json"), JSON.stringify(config, null, 2));
  writeFileSync(
    join(work, "tmux.conf"),
    [
      "set -g status off",
      "set -g remain-on-exit on",
      "set -g default-terminal tmux-256color",
      "set -g extended-keys on",
      "set -sq extended-keys-format csi-u",
    ].join("\n"),
  );

  const socket = `pi-replay-${process.pid}`;
  const { tmux, capture, captureStyled, mouse } = tmuxSession(socket, SESSION);
  const piCli = join(piInstallRoot(), "dist", "bundle", "cli.js");
  const command = [
    "env",
    `PI_REPLAY_CONFIG=${join(work, "config.json")}`,
    `PI_CODING_AGENT_DIR=${agent}`,
    "PI_OFFLINE=1",
    "PI_SKIP_VERSION_CHECK=1",
    "COLORTERM=truecolor",
    process.execPath.endsWith("node") ? process.execPath : "node",
    piCli,
    "--offline",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-na",
    "-e",
    join(ROOT, "packages", "pi-ui", "extensions", "index.ts"),
    "-e",
    join(import.meta.dir, "extension.ts"),
    "--session",
    sessionFile,
    "--model",
    `replay/${model}`,
    ...(script.thinkingLevel ? ["--thinking", script.thinkingLevel] : []),
  ];
  // Rendering adds to the recorded waits, more so in a long session: half again, and a minute.
  const timeoutMs = options.timeoutS ? options.timeoutS * 1000 : replayLength(script, options) * 1.5 + 60_000;
  const eventsPath = join(control, "events.jsonl");
  const events: TimedEvent[] = [];
  let read = 0;
  const poll = (): TimedEvent[] => {
    if (!existsSync(eventsPath)) return [];
    const text = readFileSync(eventsPath, "utf8");
    const complete = text.lastIndexOf("\n") + 1;
    const fresh = text
      .slice(read, complete)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TimedEvent);
    read = complete;
    events.push(...fresh);
    return fresh;
  };

  const frames: Frame[] = [];
  let recordingSince: number | undefined;
  const sample = () => {
    if (recordingSince === undefined || !options.gif) return;
    frames.push({ time: (performance.now() - recordingSince) / 1000, pane: captureStyled() });
  };
  const tickMs = options.gif ? 1000 / options.fps : 50;
  const deadline = performance.now() + timeoutMs;
  const dead = () => tmux("display-message", "-p", "-t", SESSION, "#{pane_dead}").trim() === "1";
  const fail = (why: string): never => {
    throw new Error(`${why}\n--- pane ---\n${capture()}\n--- work directory: ${work}`);
  };
  /** Ticks until `done` holds, sampling GIF frames and reading events. */
  const until = async (done: (fresh: TimedEvent[]) => boolean, what: string): Promise<void> => {
    for (;;) {
      const fresh = poll();
      if (options.from && recordingSince === undefined && fresh.some((event) => reached(options.from!, event)))
        recordingSince = performance.now();
      sample();
      if (done(fresh)) return;
      if (dead()) fail(`pi exited while waiting for ${what}`);
      if (performance.now() > deadline) fail(`timed out waiting for ${what}`);
      await Bun.sleep(tickMs);
    }
  };
  const settle = (ms: number) => {
    const end = performance.now() + ms;
    return until(() => performance.now() >= end, "the screen to settle");
  };

  const outputs: string[] = [];
  try {
    tmux(
      "-f",
      join(work, "tmux.conf"),
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      String(options.width),
      "-y",
      String(options.height),
      "-c",
      cwd,
      ...command,
    );
    await until(() => events.some((event) => event.type === "ready"), "pi to start");
    // The first paint follows the extension's ready event.
    await until(() => capture().trim().length > 0, "pi's first paint");
    await Bun.sleep(300);
    if (!options.from) recordingSince = performance.now();
    writeFileSync(join(control, "go"), "");
    await until(() => events.some((event) => event.type === "paused"), formatStop(options.until));
    await settle(options.settleMs);
    for (const action of options.actions) {
      const pane = capture();
      if (!pane.includes(action.text)) fail(`--${action.kind}: no row on screen holds ${JSON.stringify(action.text)}`);
      const row = rowOf(pane, action.text);
      const column = (pane.split("\n")[row - 1] ?? "").indexOf(action.text) + 1;
      if (action.kind === "hover") mouse(35, column, row);
      else {
        mouse(0, column, row);
        mouse(0, column, row, true);
      }
      await settle(options.settleMs);
    }
    const final = captureStyled();
    if (options.ansi) {
      mkdirSync(dirname(options.ansi), { recursive: true });
      writeFileSync(options.ansi, final);
      outputs.push(options.ansi);
    }
    if (options.shot) {
      mkdirSync(dirname(options.shot), { recursive: true });
      const cast = join(work, "shot.cast");
      writeFileSync(cast, asciicast([{ time: 0, pane: final }], options.width, options.height));
      renderPng(cast, join(work, "shot.gif"), options.shot, { theme: options.theme, fontSize: options.fontSize });
      outputs.push(options.shot);
    }
    if (options.gif) {
      if (recordingSince === undefined)
        fail(`--from ${formatStop(options.from!)} was not reached before --until ${formatStop(options.until)}`);
      mkdirSync(dirname(options.gif), { recursive: true });
      const recorded = distinct([...frames, { time: (performance.now() - (recordingSince ?? 0)) / 1000, pane: final }]);
      // The cast stays next to the GIF: asciinema plays it, agg renders it again.
      const cast = options.gif.replace(/\.gif$/i, "") + ".cast";
      writeFileSync(cast, asciicast(recorded, options.width, options.height));
      renderGif(cast, options.gif, { theme: options.theme, fontSize: options.fontSize });
      outputs.push(options.gif, cast);
    }
  } finally {
    if (options.keep) {
      console.log(`pi is still running: tmux -L ${socket} attach -t ${SESSION}`);
      console.log(`work directory: ${work}`);
    } else {
      try {
        tmux("kill-server");
      } catch {}
      if (!process.env.PI_REPLAY_KEEP_WORK) rmSync(work, { recursive: true, force: true });
    }
  }
  return { outputs, events };
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const { outputs, events } = await replay(options);
    const paused = events.find((event) => event.type === "paused");
    if (paused) console.log(`paused at ${formatStop(options.until)} after ${(paused.t / 1000).toFixed(1)}s`);
    for (const output of outputs) console.log(`wrote ${output}`);
    // A warning means the replay and pi disagreed about what comes next: the capture may be wrong.
    for (const event of events) if (event.type === "warning") console.error(`warning: ${event.text}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
