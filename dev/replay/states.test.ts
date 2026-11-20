import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScript, parseSession } from "./session.ts";
import { checkStop } from "./run.ts";
import { checkStates, compareDirs, indexPage, runsOf, type State, STATES } from "./states.ts";
import { parseStop } from "./stops.ts";

/** A tool stop's call number, for ordering; -1 for stops that are not numbered tool calls. */
function toolOrder(spec: string): number {
  const stop = parseStop(spec);
  if (stop.kind === "end") return Number.POSITIVE_INFINITY;
  if (stop.kind === "tool") return typeof stop.tool === "number" ? stop.tool : -1;
  return -1;
}

function stateOf(id: string, run: { id: string; session: string }, until = "end"): State {
  return { id, title: id, description: "", run, until };
}

const dir = mkdtempSync(join(tmpdir(), "pi-ui-states-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("STATES", () => {
  test("ids are unique and file-safe, and every stop is one its session's replay reaches", async () => {
    expect(() => checkStates(STATES)).not.toThrow();
    const runs = runsOf(STATES);
    const texts = await Promise.all(runs.map(({ run }) => Bun.file(run.session).text()));
    for (const [index, { states }] of runs.entries()) {
      const script = buildScript(parseSession(texts[index]!));
      for (const state of states) checkStop(script, parseStop(state.until), state.id);
    }
  });

  test("a run's states come in replay order: no stop before the one ahead of it", () => {
    for (const { states } of runsOf(STATES)) {
      const tools = states.map((state) => toolOrder(state.until)).filter((value) => value >= 0);
      expect(tools).toEqual(tools.toSorted((a, b) => a - b));
    }
  });
});

describe("runsOf", () => {
  test("groups states by run, keeping each run's states in list order", () => {
    const a = { id: "a", session: "a.jsonl" };
    const b = { id: "b", session: "b.jsonl" };
    const grouped = runsOf([stateOf("one", a), stateOf("two", b), stateOf("three", a)]);
    expect(grouped.map(({ run, states }) => [run.id, states.map((s) => s.id)])).toEqual([
      ["a", ["one", "three"]],
      ["b", ["two"]],
    ]);
  });
});

describe("checkStates", () => {
  const run = { id: "r", session: "r.jsonl" };
  test("rejects a repeated id, an unsafe id and a bad stop", () => {
    expect(() => checkStates([stateOf("x", run), stateOf("x", run)])).toThrow("used twice");
    expect(() => checkStates([stateOf("Bad Id", run)])).toThrow("use a-z");
    expect(() => checkStates([stateOf("x", run, "tool:")])).toThrow("bad stop");
  });
});

describe("compareDirs", () => {
  test("names each file that differs, is missing or is extra", () => {
    const committed = join(dir, "committed");
    const rendered = join(dir, "rendered");
    mkdirSync(committed);
    mkdirSync(rendered);
    for (const [path, text] of [
      [join(committed, "same.ans"), "x"],
      [join(rendered, "same.ans"), "x"],
      [join(committed, "changed.png"), "a"],
      [join(rendered, "changed.png"), "b"],
      [join(committed, "gone.ans"), "x"],
      [join(rendered, "new.ans"), "x"],
    ])
      writeFileSync(path!, text!);
    expect(compareDirs(committed, rendered)).toEqual([
      "changed.png: differs",
      "gone.ans: not rendered",
      "new.ans: not committed",
    ]);
  });
});

describe("indexPage", () => {
  test("the mosaic, then each state's title, description and image, in order", () => {
    const page = indexPage(STATES.slice(0, 2));
    expect(page).toStartWith("# pi-ui states\n");
    expect(page).toContain("![Every state](mosaic.png)");
    const first = page.indexOf(`## ${STATES[0]!.title}`);
    const second = page.indexOf(`## ${STATES[1]!.title}`);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(page).toContain(`${STATES[0]!.description}\n\n![${STATES[0]!.title}](${STATES[0]!.id}.png)`);
  });
});
