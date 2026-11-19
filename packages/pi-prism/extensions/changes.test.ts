import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectChanges,
  diffWithinBudget,
  installFileChanges,
  LIMITS,
  recordedChanges,
  runGit,
  takeSnapshot,
  type Git,
} from "./changes.ts";

/** A git that never reads the user's or the system's configuration, and never signs. */
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: ENV,
  }).toString();

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});
afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

let template: string | undefined;

/** A repository with a tracked file, a tracked file with unstaged edits, an ignored file and an untracked one. */
function repository(): string {
  if (!template) {
    template = mkdtempSync(join(tmpdir(), "prism-changes-template-"));
    git(template, "init", "-q");
    writeFileSync(join(template, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(template, "clean.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(template, "dirty.txt"), "index\n");
    mkdirSync(join(template, "src"));
    writeFileSync(join(template, "src", "gone.ts"), "export const gone = 1;\n");
    git(template, "add", ".");
    git(template, "commit", "-q", "-m", "init");
    writeFileSync(join(template, "dirty.txt"), "before the command\n");
    writeFileSync(join(template, "ignored.txt"), "ignored\n");
    mkdirSync(join(template, "tmp"));
    writeFileSync(join(template, "tmp", "notes.txt"), "draft\n");
  }
  // A copy is cheaper than a fresh repository; refreshing its index makes its clean files clean again.
  const root = mkdtempSync(join(tmpdir(), "prism-changes-"));
  repos.push(root);
  cpSync(template, root, { recursive: true });
  git(root, "update-index", "-q", "--refresh");
  return root;
}

/** Wait past the file system's timestamp granularity, so a rewrite always changes the mtime. */
const tick = () => Bun.sleep(5);

describe("a shell command's file changes", () => {
  test("outside a git work tree there is nothing to snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-plain-"));
    repos.push(dir);
    expect(await takeSnapshot(dir)).toBeUndefined();
  });

  test("modified, created and deleted files are diffed against their content before the command", async () => {
    const root = repository();
    const before = await takeSnapshot(root);
    expect(before).toBeDefined();
    await tick();
    writeFileSync(join(root, "clean.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(root, "dirty.txt"), "after the command\n");
    writeFileSync(join(root, "tmp", "notes.txt"), "draft\nmore\n");
    writeFileSync(join(root, "tmp", "one.txt"), "Edits: 5\n");
    writeFileSync(join(root, "ignored.txt"), "still ignored\n");
    unlinkSync(join(root, "src", "gone.ts"));
    const changes = await collectChanges(before!);
    expect(changes?.files.map(({ path, kind }) => `${kind} ${path}`)).toEqual([
      "modified clean.txt",
      "modified dirty.txt",
      "deleted src/gone.ts",
      "modified tmp/notes.txt",
      "created tmp/one.txt",
    ]);
    const patch = (path: string) => changes?.files.find((file) => file.path === path)?.patch ?? "";
    expect(patch("clean.txt")).toContain("-two\n+TWO\n");
    // A tracked file edited before the command diffs from what it held then, not from the index.
    expect(patch("dirty.txt")).toContain("-before the command\n+after the command\n");
    expect(patch("tmp/notes.txt")).toContain(" draft\n+more\n");
    expect(patch("tmp/one.txt")).toContain("@@ -0,0 +1,1 @@\n+Edits: 5\n");
    expect(changes?.files.find((file) => file.kind === "deleted")?.patch).toBeUndefined();
  });

  test("a file rewritten with the same bytes, and a run that changes nothing, record nothing", async () => {
    const root = repository();
    const before = await takeSnapshot(root);
    await tick();
    writeFileSync(join(root, "clean.txt"), "one\ntwo\nthree\n");
    expect(await collectChanges(before!)).toBeUndefined();
  });

  test("binary files and files past the caps report their change without a diff", async () => {
    const root = repository();
    writeFileSync(join(root, "tmp", "big.txt"), "x".repeat(300));
    const limits = { ...LIMITS, maxFileBytes: 100 };
    const before = await takeSnapshot(root, runGit, limits);
    await tick();
    writeFileSync(join(root, "tmp", "big.txt"), "y".repeat(300));
    writeFileSync(join(root, "image.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
    const changes = await collectChanges(before!, runGit, (path) => `patch ${path}`, limits);
    expect(changes?.files).toEqual([
      { path: "image.png", kind: "created", note: "binary" },
      { path: "tmp/big.txt", kind: "modified", note: "too large" },
    ]);
  });

  test("the saved-content cap still watches the files it could not read", async () => {
    const root = repository();
    const before = await takeSnapshot(root, runGit, { ...LIMITS, maxSavedFiles: 0 });
    await tick();
    writeFileSync(join(root, "tmp", "notes.txt"), "rewritten\n");
    const changes = await collectChanges(before!);
    expect(changes?.files).toEqual([{ path: "tmp/notes.txt", kind: "modified", note: "too large" }]);
  });

  test("a work tree with too many files is skipped, and a long list is counted past its cap", async () => {
    const root = repository();
    expect(await takeSnapshot(root, runGit, { ...LIMITS, maxFiles: 3 })).toBeUndefined();
    const before = await takeSnapshot(root);
    await tick();
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, `${name}.txt`), name);
    const changes = await collectChanges(before!, runGit, undefined, { ...LIMITS, maxListed: 2 });
    expect(changes?.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(changes?.more).toBe(1);
  });

  test("paths read from the session's directory, even below the top level", async () => {
    const root = repository();
    const before = await takeSnapshot(join(root, "src"));
    await tick();
    writeFileSync(join(root, "clean.txt"), "changed\n");
    writeFileSync(join(root, "src", "new.ts"), "export {};\n");
    const changes = await collectChanges(before!);
    expect(changes?.files.map((file) => file.path)).toEqual(["../clean.txt", "new.ts"]);
  });

  test("taking a snapshot and collecting changes leave the repository untouched", async () => {
    const root = repository();
    const state = () => ({
      index: createHash("sha1")
        .update(readFileSync(join(root, ".git", "index")))
        .digest("hex"),
      refs: git(root, "for-each-ref"),
      stash: git(root, "stash", "list"),
      objects: readdirSync(join(root, ".git", "objects"), { recursive: true }).length,
    });
    const before = state();
    const snapshot = await takeSnapshot(root);
    await tick();
    writeFileSync(join(root, "clean.txt"), "changed\n");
    expect(await collectChanges(snapshot!)).toBeDefined();
    expect(state()).toEqual(before);
  });

  test("git missing or failing skips quietly", async () => {
    expect(await takeSnapshot(repository(), async () => undefined)).toBeUndefined();
  });
});

/** `count` numbered lines, each starting with `tag`. */
const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n");

describe("the diff's cost", () => {
  test("a new file, a deleted one and a one-line edit of a large file are diffed", () => {
    expect(diffWithinBudget("", lines(8000, "a"))).toBe(true);
    expect(diffWithinBudget(lines(8000, "a"), "")).toBe(true);
    expect(diffWithinBudget(lines(8000, "a"), lines(8000, "a").replace("a 100\n", "A 100\n"))).toBe(true);
  });

  test("scattered edits across a large file are diffed", () => {
    const edited = lines(8000, "a")
      .split("\n")
      .map((line, index) => (index % 1000 === 0 ? line.toUpperCase() : line))
      .join("\n");
    expect(diffWithinBudget(lines(8000, "a"), edited)).toBe(true);
  });

  test("a large file rewritten line for line is not: jsdiff would stall for seconds", () => {
    expect(diffWithinBudget(lines(8000, "a"), lines(8000, "b"))).toBe(false);
    const interleaved = lines(8000, "a")
      .split("\n")
      .map((line, index) => (index % 2 ? line.toUpperCase() : line))
      .join("\n");
    expect(diffWithinBudget(lines(8000, "a"), interleaved)).toBe(false);
  });
});

describe("recorded changes", () => {
  test("only well-formed records are read back", () => {
    expect(recordedChanges(undefined)).toBeUndefined();
    expect(recordedChanges({ prismChanges: { files: "nope" } })).toBeUndefined();
    expect(
      recordedChanges({
        prismChanges: { files: [{ path: "a", kind: "modified", patch: "p" }, { path: 3 }, null], more: 2 },
      }),
    ).toEqual({ files: [{ path: "a", kind: "modified", patch: "p" }], more: 2 });
  });
});

/** A runner whose calls never return. */
const hung: Git = () => new Promise(() => {});

type Handler = (event: any, ctx: any) => unknown;

/** The handlers `installFileChanges` registers, one per event, fired by name. */
function hooks(options: Parameters<typeof installFileChanges>[1] = {}) {
  const handlers = new Map<string, Handler>();
  installFileChanges({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never, options);
  return async (name: string, event: object, ctx: object = {}) => await handlers.get(name)?.(event, ctx);
}

describe("the hooks", () => {
  test("a top-level shell call records its changes on the result, beside pi's own details", async () => {
    const root = repository();
    const fire = hooks();
    const ctx = { mode: "tui", cwd: root };
    await fire("tool_call", { toolName: "bash", toolCallId: "1", input: {} }, ctx);
    writeFileSync(join(root, "tmp", "one.txt"), "Edits: 5\n");
    const result = (await fire(
      "tool_result",
      { toolName: "bash", toolCallId: "1", details: { fullOutputPath: "/tmp/x" } },
      ctx,
    )) as { details: { fullOutputPath: string; prismChanges: unknown } };
    expect(result.details.fullOutputPath).toBe("/tmp/x");
    expect(recordedChanges(result.details)?.files.map((file) => file.path)).toEqual(["tmp/one.txt"]);
  });

  test("other tools, nested calls and other modes take no snapshot", async () => {
    const calls: string[][] = [];
    const fire = hooks({
      git: async (args) => {
        calls.push(args);
        return undefined;
      },
    });
    await fire("tool_call", { toolName: "read", toolCallId: "1" }, { mode: "tui", cwd: "/" });
    await fire("tool_call", { toolName: "bash", toolCallId: "2", parentToolCallId: "0" }, { mode: "tui", cwd: "/" });
    await fire("tool_call", { toolName: "bash", toolCallId: "3" }, { mode: "print", cwd: "/" });
    expect(calls).toEqual([]);
    expect(await fire("tool_result", { toolName: "bash", toolCallId: "3" })).toBeUndefined();
  });

  test("a snapshot that overruns its deadline records nothing and lets the command run", async () => {
    const fire = hooks({ git: hung, limits: { ...LIMITS, deadlineMs: 20 } });
    const started = performance.now();
    await fire("tool_call", { toolName: "bash", toolCallId: "1" }, { mode: "tui", cwd: "/" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(await fire("tool_result", { toolName: "bash", toolCallId: "1" })).toBeUndefined();
  });
});
