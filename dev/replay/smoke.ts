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
      // At 100x40 the last image fills rows 15 to 32 of the final screen. One replay, two pauses:
      // the click and ←, then Escape. A capture at the stop before it does not replay on; its
      // actions follow the earlier ones.
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
      options.captures = [
        ...capturesOf(options),
        { until: options.until, actions: [{ kind: "key", key: "\x1b" }], ansi: closedAnsi },
      ];
      await replay(options);
      const viewer = plain(readFileSync(viewerAnsi, "utf8"));
      assert(
        viewer.includes("1 of 2 · read · shots/one.png · ← → switch images · esc closes"),
        `a click on the last image should open the viewer, and left should step to the first\n${viewer}`,
      );
      const closed = plain(readFileSync(closedAnsi, "utf8"));
      assert(!closed.includes("switch images"), `escape should close the viewer\n${closed}`);
      console.log("replay smoke: a click opened the image viewer; left stepped back, escape closed it");
    } finally {
      if (protocol === undefined) delete process.env.PI_IMAGE_PROTOCOL;
      else process.env.PI_IMAGE_PROTOCOL = protocol;
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) await replaySmoke();
