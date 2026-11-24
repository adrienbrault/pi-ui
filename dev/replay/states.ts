// oxlint-disable no-await-in-loop -- runs share a pool, one replay at a time per slot
/**
 * Key UI states of pi-ui, rendered from real replays to PNG and ANSI text in docs/states/, with a
 * mosaic of them all and an index page. The renders are reproducible: on one machine the same
 * command writes the same bytes, so a UI change shows up as an image diff in git. The `.ans` text
 * captures are the portable truth; the PNGs also depend on this machine's fonts, agg and ffmpeg.
 *
 *   bun run states            render every state into docs/states/
 *   bun run states:check      render into a scratch directory and compare byte for byte
 *   bun run states -- --only summary   render the states whose id contains "summary", into tmp/states/
 *
 * Each run replays one session once and pauses at each of its states in order (see run.ts,
 * `captures`). Actions last within a run: a click keeps its block open in later states, so a
 * state that clicks is the last of its run, or the next states build on it on purpose.
 *
 * Needs tmux, agg, ffmpeg and ImageMagick; not part of `bun run check`.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Action, parseOptions, replay } from "./run.ts";
import { parseStop } from "./stops.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const OUT = join(ROOT, "docs", "states");
const DEMO = join(import.meta.dir, "sessions", "deepseek-review.jsonl");
const CHANGES = join(import.meta.dir, "fixtures", "file-changes.jsonl");
const PROMPTS = join(import.meta.dir, "fixtures", "two-prompts.jsonl");
const TODOS = join(import.meta.dir, "fixtures", "todos.jsonl");
/** One question prompt, answered with its first option. */
const ASK = join(import.meta.dir, "fixtures", "ask.jsonl");
/** One delegated child: its brief, its answer, and what it spent. */
const SUBAGENT = join(import.meta.dir, "fixtures", "subagent.jsonl");

export interface Run {
  id: string;
  session: string;
  width?: number;
  height?: number;
  theme?: "dark" | "light";
}

export interface State {
  id: string;
  title: string;
  /** One line for the index: what the image shows. */
  description: string;
  run: Run;
  /** A stop spec (stops.ts). */
  until: string;
  actions?: Action[];
}

// pi's "Jump to latest message" banner covers the last transcript row while the view is scrolled
// up: a state shows its transcript unscrolled when it fits, and otherwise keeps its subject above
// that row.
const main: Run = { id: "main", session: DEMO };
const thought: Run = { id: "thought", session: DEMO };
const forming: Run = { id: "forming", session: DEMO, height: 41 };
const aged: Run = { id: "aged", session: PROMPTS };
// Tall enough to show the whole transcript at tool 37 without scrolling.
const groups: Run = { id: "groups", session: DEMO, height: 46 };
const members: Run = { id: "members", session: DEMO };
const prompt: Run = { id: "prompt", session: PROMPTS, height: 44 };
const opened: Run = { id: "opened", session: DEMO };
const command: Run = { id: "command", session: DEMO };
const changes: Run = { id: "changes", session: CHANGES, height: 36 };
const light: Run = { id: "light", session: DEMO, theme: "light" };
const narrow: Run = { id: "narrow", session: DEMO, width: 70 };
// Its own run: a pause in the middle of a message would shift the rates of that message's later states.
const writing: Run = { id: "writing", session: DEMO };
const todos: Run = { id: "todos", session: TODOS, height: 34 };
const ask: Run = { id: "ask", session: ASK, height: 34 };
const subagent: Run = { id: "subagent", session: SUBAGENT, height: 30 };

const hover = (text: string): Action => ({ kind: "hover", text });
const click = (text: string): Action => ({ kind: "click", text });

/** In the order of the index and the mosaic. */
export const STATES: State[] = [
  {
    id: "session-start",
    title: "Session start",
    description: "The prompt, the first reply, and the first two shell commands with their output.",
    run: main,
    until: "tool:1:end",
  },
  {
    id: "read-line-numbers",
    title: "Read with line numbers",
    description: "A read shows the file's first and last lines, numbered, with a notice for the lines between.",
    run: main,
    until: "tool:5:end",
  },
  {
    id: "bash-running",
    title: "Running shell command",
    description: "A shell command still running: its spinner, its clock, and the output printed so far.",
    run: main,
    until: "tool:17@40%",
  },
  {
    id: "thought-streaming",
    title: "Thought streaming",
    description: "A long thought as it streams: its token count, rate and time, and its newest words at the bottom.",
    run: main,
    until: "message:14@39.5%",
  },
  {
    id: "thought-hovered",
    title: "Thought under the mouse",
    description: "Hovering a thought that can open lights its notice and shows its scroll bar in the left margin.",
    run: thought,
    until: "tool:27:end",
    actions: [hover("50 more lines")],
  },
  {
    id: "bash-failed",
    title: "Failed shell command",
    description: "A failed command shows its exit code in the header, after a settled thought.",
    run: main,
    until: "tool:27:end",
  },
  {
    id: "search-output",
    title: "Search output",
    description: "grep over several files: a header per file, line numbers in a gutter, and highlighting.",
    run: main,
    until: "tool:57:end",
  },
  {
    id: "write-preview",
    title: "Write",
    description: "A write shows the start and the end of the new file, numbered.",
    run: main,
    until: "tool:85:end",
  },
  {
    id: "edit-writing",
    title: "Edit being written",
    description:
      "An edit streams as the model writes it: each replacement's old text as removed lines, then its new text as added ones.",
    run: writing,
    until: "message:69@90%",
  },
  {
    id: "edit-diff",
    title: "Edit",
    description: "An edit shows its diff with the old and new line numbers.",
    run: main,
    until: "tool:101:end",
  },
  {
    id: "session-end",
    title: "Session end",
    description: "The final answer, after every block above it folded.",
    run: main,
    until: "end",
  },
  {
    id: "group-forming",
    title: "Group forming",
    description: "The newest folded group lists its members under its summary while it has five or fewer.",
    run: forming,
    until: "tool:10:end",
    actions: [{ kind: "scroll", lines: 60 }],
  },
  {
    id: "blocks-decaying",
    title: "Older blocks shorter",
    description:
      "Blocks lose lines as newer ones arrive, the oldest down to a notice and a few lines; one row is fading out.",
    run: forming,
    until: "tool:12:end",
    // Six rows down from the top, where group-forming left the view: the banner sits on a gap between blocks.
    actions: [{ kind: "scroll", lines: -6 }],
  },
  {
    id: "thought-one-row",
    title: "Thought on one row",
    description:
      "An old thought folded into the forming group keeps one row: the start and the end of its reasoning, cut in the middle.",
    run: aged,
    until: "tool:9:end",
    actions: [{ kind: "scroll", lines: 60 }],
  },
  {
    id: "summary-folded",
    title: "Folded summary",
    description:
      "Older blocks folded into one summary line under the first reply; it counts the failed command in red.",
    run: groups,
    until: "tool:37:end",
  },
  {
    id: "summary-hovered",
    title: "Summary under the mouse",
    description: "Hovering the summary lights its marker: a click opens it.",
    run: groups,
    until: "tool:37:end",
    actions: [hover("Ran 25 shell commands")],
  },
  {
    id: "summary-opened",
    title: "Summary opened",
    description: "A click on the summary lists its members in aligned columns.",
    run: members,
    until: "tool:13:end",
    actions: [{ kind: "scroll", lines: 60 }, click("Ran 4 shell commands")],
  },
  {
    id: "member-opened",
    title: "Member opened",
    description: "A click on one member opens its full command and output inside the group.",
    run: members,
    until: "tool:13:end",
    actions: [click("find . -maxdepth 2")],
  },
  {
    id: "member-failed",
    title: "Failed call in a group",
    description:
      "The summary opened and scrolled to its failed member: ✗ and the exit code, among the calls around it.",
    run: groups,
    until: "tool:37:end",
    actions: [click("Ran 25 shell commands"), { kind: "scroll", lines: 8 }],
  },
  {
    id: "prompt-folding",
    title: "New prompt",
    description:
      "A new prompt ends the run before it: its blocks fold into one summary, a row at a time, oldest first, as the reply starts.",
    run: prompt,
    until: "message:12@0%",
  },
  {
    id: "prompt-folded",
    title: "Previous run folded",
    description: "A moment later every tool and thought of the previous run is in the summary; its answer stays.",
    run: prompt,
    until: "message:12@35%",
  },
  {
    id: "block-hovered",
    title: "Block under the mouse",
    description: "Hovering a block that can open lights its notice and shows its scroll bar in the left margin.",
    run: opened,
    until: "tool:5:end",
    actions: [hover("read · docs/PLAN.md")],
  },
  {
    id: "block-opened",
    title: "Block opened",
    description: "A click opens the block's full output; the scroll bar's thumb shows how much is on screen.",
    run: opened,
    until: "tool:5:end",
    actions: [click("read · docs/PLAN.md")],
  },
  {
    id: "command-opened",
    title: "Long command opened",
    description: "A command clipped in its header shows in full, wrapped, once its block is open.",
    run: command,
    until: "tool:4:end",
    // The open block fills the screen: scroll back up to its header.
    actions: [click("wc -l $(find"), { kind: "scroll", lines: 12 }],
  },
  {
    id: "bash-file-changes",
    title: "Files a command changed",
    description: "A shell command opened: under its output, the diffs of the files it changed, created and deleted.",
    run: changes,
    until: "tool:1:end",
    actions: [click("bun run release 1.5.0")],
  },
  {
    id: "light-theme",
    title: "Light theme",
    description: "The same session in pi's light theme.",
    run: light,
    until: "tool:5:end",
  },
  {
    id: "narrow-width",
    title: "Narrow terminal",
    description: "A 70-column terminal: headers shorten their commands and wrap thoughts to fit.",
    run: narrow,
    until: "tool:28:end",
  },
  {
    id: "todos-panel",
    title: "Todos panel",
    description:
      "The session's todo list above the editor: a count, its bar, the running step's spinner, and the #ids the transcript's todo calls share.",
    run: todos,
    until: "tool:3:end",
  },
  {
    id: "todos-completed",
    title: "Todos, one step done",
    description: "After a step completes its row dims to a check and the bar fills a cell.",
    run: todos,
    until: "tool:4:end",
  },
  {
    id: "ask-answered",
    title: "Ask, answered",
    description:
      "A question prompt's row: the question as its title, and the answer it came back with checked under it.",
    run: ask,
    until: "tool:1:end",
  },
  {
    id: "ask-opened",
    title: "Ask, opened",
    description:
      "Opening the row lists every option it offered, the chosen one checked, each trade-off under its label.",
    run: ask,
    until: "tool:1:end",
    actions: [click("Renumber, rebase, push both PRs")],
  },
  {
    id: "subagent-done",
    title: "Subagent, done",
    description:
      "A delegated child's row: its last message as the body, the tokens it spent in the header, and its tool and turn counts under it.",
    run: subagent,
    until: "tool:1:end",
  },
];

/** Runs, each with its states in replay order. */
export function runsOf(states: State[]): Array<{ run: Run; states: State[] }> {
  const runs = new Map<Run, State[]>();
  for (const state of states) runs.set(state.run, [...(runs.get(state.run) ?? []), state]);
  return [...runs].map(([run, list]) => ({ run, states: list }));
}

/** Every state id is unique and names a file safely. */
export function checkStates(states: State[]): void {
  const seen = new Set<string>();
  for (const state of states) {
    if (!/^[a-z0-9-]+$/.test(state.id)) throw new Error(`state id ${JSON.stringify(state.id)}: use a-z, 0-9 and -`);
    if (seen.has(state.id)) throw new Error(`state id ${state.id} is used twice`);
    seen.add(state.id);
    parseStop(state.until);
  }
}

async function renderRun(run: Run, states: State[], out: string): Promise<void> {
  const options = parseOptions([
    run.session,
    "--width",
    String(run.width ?? 120),
    "--height",
    String(run.height ?? 40),
    "--theme",
    run.theme ?? "dark",
    // Messages no state stops inside stream in wider deltas: the replay takes a minute, not three.
    "--coarse",
    "400",
  ]);
  options.captures = states.map((state) => ({
    until: parseStop(state.until),
    actions: state.actions ?? [],
    ansi: join(out, `${state.id}.ans`),
    shot: join(out, `${state.id}.png`),
  }));
  const { events } = await replay(options);
  for (const event of events)
    if (event.type === "warning") throw new Error(`run ${run.id}: the replay warned: ${event.text}`);
}

function magick(args: string[]): void {
  const result = Bun.spawnSync(["magick", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`magick failed: ${result.stderr.toString().trim()}`);
}

/** Options that make ImageMagick's PNGs the same bytes every time. */
const REPRODUCIBLE = ["-limit", "thread", "1", "-strip", "-depth", "8", "-define", "png:exclude-chunks=date,time,tIME"];
const LABEL_FONT = "/System/Library/Fonts/Menlo.ttc";

/** Every state, scaled down with its title, in index order, in 256 colours to keep it small. */
function mosaic(states: State[], out: string): void {
  const full = join(out, "mosaic.full.png");
  magick([
    "montage",
    ...REPRODUCIBLE.slice(0, 3),
    "-font",
    LABEL_FONT,
    "-pointsize",
    "18",
    "-background",
    "#1e1e1e",
    "-fill",
    "#d4d4d4",
    ...states.flatMap((state) => ["-label", state.title, join(out, `${state.id}.png`)]),
    "-tile",
    "4x",
    // Every tile fits one box: a narrow state is as tall as the others, not taller.
    "-geometry",
    "576x386+12+12",
    ...REPRODUCIBLE.slice(3),
    full,
  ]);
  magick([full, ...REPRODUCIBLE.slice(0, 3), "-colors", "256", ...REPRODUCIBLE.slice(3), join(out, "mosaic.png")]);
  rmSync(full);
}

export function indexPage(states: State[]): string {
  const lines = [
    "# pi-ui states",
    "",
    "Key states of pi-ui, rendered from replays of real sessions in real pi (see `dev/replay/states.ts`). Each state has a PNG and its `.ans` text capture. `bun run states` writes this directory and `bun run states:check` compares a fresh render with it, byte for byte. Do not edit these files by hand.",
    "",
    "![Every state](mosaic.png)",
    "",
  ];
  for (const state of states)
    lines.push(`## ${state.title}`, "", `${state.description}`, "", `![${state.title}](${state.id}.png)`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Renders `states` into `out`: PNG and ANSI per state, then, for the full list, the mosaic and the index. */
export async function renderStates(states: State[], out: string, options: { parallel?: number } = {}): Promise<void> {
  checkStates(states);
  mkdirSync(out, { recursive: true });
  // A full render starts clean, so a state removed from the list leaves no file behind.
  if (states === STATES)
    for (const name of readdirSync(out)) if (/\.(png|ans)$|^README\.md$/.test(name)) rmSync(join(out, name));
  const queue = runsOf(states);
  const parallel = Math.max(1, options.parallel ?? 4);
  const errors: Error[] = [];
  await Promise.all(
    Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const started = performance.now();
        try {
          await renderRun(next.run, next.states, out);
          console.log(
            `run ${next.run.id}: ${next.states.map((state) => state.id).join(", ")} (${((performance.now() - started) / 1000).toFixed(0)}s)`,
          );
        } catch (error) {
          errors.push(new Error(`run ${next.run.id}: ${(error as Error).message}`));
        }
      }
    }),
  );
  if (errors.length) throw new Error(errors.map((error) => error.message).join("\n\n"));
  if (states === STATES) {
    mosaic(states, out);
    writeFileSync(join(out, "README.md"), indexPage(states));
  }
}

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

/** The files of `expected` and `actual` that differ, are missing or are extra. */
export function compareDirs(expected: string, actual: string): string[] {
  const left = listDir(expected);
  const right = listDir(actual);
  const problems: string[] = [];
  for (const name of left) {
    if (!right.includes(name)) problems.push(`${name}: not rendered`);
    else if (!readFileSync(join(expected, name)).equals(readFileSync(join(actual, name))))
      problems.push(`${name}: differs`);
  }
  for (const name of right) if (!left.includes(name)) problems.push(`${name}: not committed`);
  return problems;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const onlyAt = args.indexOf("--only");
  const only = onlyAt === -1 ? undefined : args[onlyAt + 1];
  const outAt = args.indexOf("--out");
  const started = performance.now();
  try {
    if (check) {
      const scratch = mkdtempSync(join(tmpdir(), "pi-ui-states-"));
      await renderStates(STATES, scratch);
      const problems = compareDirs(OUT, scratch);
      if (problems.length) {
        // The scratch render stays, to compare by eye.
        console.error(`states differ from docs/states/ (rendered into ${scratch}):\n  ${problems.join("\n  ")}`);
        process.exit(1);
      }
      rmSync(scratch, { recursive: true, force: true });
      console.log(`states current: ${STATES.length} states, every file identical`);
    } else {
      const states = only ? STATES.filter((state) => state.id.includes(only)) : STATES;
      if (!states.length) throw new Error(`no state id contains ${JSON.stringify(only)}`);
      // A partial render never overwrites the committed directory.
      const out = outAt !== -1 ? args[outAt + 1]! : only ? join(ROOT, "tmp", "states") : OUT;
      await renderStates(states, out);
      console.log(`wrote ${states.length} states to ${out}`);
    }
    console.log(`in ${((performance.now() - started) / 1000).toFixed(0)}s`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
