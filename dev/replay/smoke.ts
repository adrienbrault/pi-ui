/**
 * The replay loop end to end, on the synthetic fixture: pi in tmux, paused mid-thought, then
 * captured to ANSI and PNG; then the whole session to its end. Needs tmux, agg and ffmpeg.
 *
 * Run: bun run replay:smoke (bun run e2e runs it too)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturesOf, parseOptions, replay } from "./run.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "synthetic.jsonl");
/** Two `read` calls on PNGs: the image viewer's session. */
const IMAGES = join(import.meta.dir, "fixtures", "images.jsonl");
/** Three `todo` calls, so the panel has a step to run and one to finish. */
const TODOS = join(import.meta.dir, "fixtures", "todos.jsonl");
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const plain = (ansi: string) => Bun.stripANSI(ansi);

export async function replaySmoke(): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), "pi-replay-smoke-"));
  try {
    const shot = join(out, "thinking.png");
    const ansi = join(out, "thinking.ans");
    const mid = await replay(
      parseOptions([FIXTURE, "--until", "message:1@40%", "--shot", shot, "--ansi", ansi, "--settle", "500"]),
    );
    const screen = plain(readFileSync(ansi, "utf8"));
    assert(screen.includes("The greeting test fails. Find out why and fix it."), `the prompt should show\n${screen}`);
    assert(screen.includes("The failing test is about the greeting"), `the thought should be streaming\n${screen}`);
    assert(!screen.includes("the fixture may be wrong instead"), `the thought should stop part way\n${screen}`);
    assert(!screen.includes("src/greet.ts ·"), `the read call should not have started\n${screen}`);
    assert(
      [...readFileSync(shot).subarray(0, 4)].every((byte, i) => byte === PNG_SIGNATURE[i]),
      "the shot should be a PNG",
    );
    assert(
      mid.events.some((event) => event.type === "paused"),
      "the replay should report its pause",
    );
    console.log("replay smoke: paused mid-thought; ANSI and PNG written");

    const endAnsi = join(out, "end.ans");
    const end = await replay(
      parseOptions([FIXTURE, "--speed", "4", "--height", "60", "--ansi", endAnsi, "--settle", "800"]),
    );
    const last = plain(readFileSync(endAnsi, "utf8"));
    assert(last.includes("All twelve packages build."), `the replay should reach the last message\n${last}`);
    assert(/Ran \d+ shell commands/.test(last), `the older build calls should fold into a group\n${last}`);
    const turns = end.events.filter((event) => event.type === "settled").length;
    assert(turns === 3, `all three turns should settle, saw ${turns}`);
    console.log("replay smoke: the whole session replayed; older calls folded");

    // pi draws images only on a terminal it believes shows them; tmux strips the image data,
    // but the rows, the click and the viewer are pi's own.
    const protocol = process.env.PI_IMAGE_PROTOCOL;
    process.env.PI_IMAGE_PROTOCOL = "kitty";
    try {
      const viewerAnsi = join(out, "viewer.ans");
      const closedAnsi = join(out, "viewer-closed.ans");
      const reopenedAnsi = join(out, "viewer-reopened.ans");
      const clickedAnsi = join(out, "viewer-clicked.ans");
      // At 100x40 the last image fills rows 15 to 32 of the final screen. One replay, four pauses:
      // the click and ←, then Escape, then a click to open it again, then a click inside it. A
      // capture at the stop before it does not replay on; its actions follow the earlier ones.
      const options = parseOptions([
        IMAGES,
        "--width",
        "100",
        "--height",
        "40",
        "--click-row",
        "20",
        "--key",
        "left",
        "--ansi",
        viewerAnsi,
      ]);
      const escape = { kind: "key", key: "\x1b" } as const;
      const openAgain = { kind: "clickRow", row: 20 } as const;
      // Row 12 is inside the frame: below the caption, over the image.
      const clickInside = { kind: "clickRow", row: 12 } as const;
      options.captures = [
        ...capturesOf(options),
        { until: options.until, actions: [escape], ansi: closedAnsi },
        { until: options.until, actions: [escape, openAgain], ansi: reopenedAnsi },
        { until: options.until, actions: [escape, openAgain, clickInside], ansi: clickedAnsi },
      ];
      await replay(options);
      const caption = "1 of 2 · read · shots/one.png · ← → switch images";
      // A later click opens the image under the pointer, which is the last one: the frame's keys are
      // what every open and close shares.
      const open = "← → switch images";
      const viewer = plain(readFileSync(viewerAnsi, "utf8"));
      assert(
        viewer.includes(caption),
        `a click on the last image should open the viewer, and left should step to the first\n${viewer}`,
      );
      const closed = plain(readFileSync(closedAnsi, "utf8"));
      assert(!closed.includes(open), `escape should close the viewer\n${closed}`);
      const reopened = plain(readFileSync(reopenedAnsi, "utf8"));
      assert(reopened.includes(open), `a click on the image should open it again after a close\n${reopened}`);
      const clicked = plain(readFileSync(clickedAnsi, "utf8"));
      assert(!clicked.includes(open), `a click inside the viewer should close it as escape does\n${clicked}`);
      console.log(
        "replay smoke: a click opened the image viewer; left stepped back; escape and a click inside it closed",
      );
    } finally {
      if (protocol === undefined) delete process.env.PI_IMAGE_PROTOCOL;
      else process.env.PI_IMAGE_PROTOCOL = protocol;
    }

    // A recorded todo list: pi-ui owns the `todo` rows and draws the list above the editor.
    const todosAnsi = join(out, "todos.ans");
    await replay(
      parseOptions([TODOS, "--width", "100", "--height", "34", "--until", "tool:3:end", "--ansi", todosAnsi]),
    );
    const todosView = plain(readFileSync(todosAnsi, "utf8"));
    assert(todosView.includes("● todo · add"), `pi-ui should render the todo rows\n${todosView}`);
    assert(todosView.includes("● todo · start #2"), `a started todo's header should name its row\n${todosView}`);
    assert(todosView.includes("● Todos 0/2  ▱▱"), `the panel should count the work\n${todosView}`);
    assert(todosView.includes("  ○ #1 Read the layout"), `a pending todo keeps its row and id\n${todosView}`);
    assert(
      /^ {2}\S #2 Write the panel \(Writing the panel renderer\)/m.test(todosView),
      `the running todo's row should carry the spinner and what it is doing\n${todosView}`,
    );
    console.log("replay smoke: the todo rows and the panel above the editor came from pi-ui");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) await replaySmoke();
