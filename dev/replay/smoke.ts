/**
 * The replay loop end to end, on the synthetic fixture: pi in tmux, paused mid-thought, then
 * captured to ANSI and PNG; then the whole session to its end. Needs tmux, agg and ffmpeg.
 *
 * Run: bun run replay:smoke (bun run e2e runs it too)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions, replay } from "./run.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "synthetic.jsonl");
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
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) await replaySmoke();
