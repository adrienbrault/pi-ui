import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as coding from "@earendil-works/pi-coding-agent";
import {
  boundedPatch,
  collectChanges,
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
    template = mkdtempSync(join(tmpdir(), "pi-ui-changes-template-"));
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
  const root = mkdtempSync(join(tmpdir(), "pi-ui-changes-"));
  repos.push(root);
  cpSync(template, root, { recursive: true });
  git(root, "update-index", "-q", "--refresh");
  return root;
}

/** Wait past the file system's timestamp granularity, so a rewrite always changes the mtime. */
const tick = () => Bun.sleep(5);

describe("a shell command's file changes", () => {
  test("outside a git work tree there is nothing to snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ui-plain-"));
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

/** A git that runs the real one and records each call: its arguments, its input and the bytes it returned. */
function recording() {
  const calls: Array<{ args: string[]; input: string; bytes: number }> = [];
  const spy: Git = async (args, cwd, timeout, input, maxBytes) => {
    const output = await runGit(args, cwd, timeout, input, maxBytes);
    calls.push({ args, input: input ?? "", bytes: output?.length ?? 0 });
    return output;
  };
  /** The blob ids whose contents were read. */
  const read = () =>
    calls.filter((call) => call.args.includes("--batch")).flatMap((call) => call.input.split("\n").filter(Boolean));
  return { spy, calls, read };
}

/** The blob a tracked file holds in the index. */
const blobOf = (root: string, path: string) => git(root, "rev-parse", `:${path}`).trim();

/** Commit `files` (name to content) to the repository at `root`. */
function commit(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, "add", ...Object.keys(files));
  git(root, "commit", "-q", "-m", "files");
}

describe("files outside the work tree", () => {
  test("a directory replaced by a symlink does not lead the diff outside the work tree", async () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "pi-ui-outside-"));
    repos.push(outside);
    writeFileSync(join(outside, "gone.ts"), "a secret outside the work tree\n");
    const before = await takeSnapshot(root);
    await tick();
    rmSync(join(root, "src"), { recursive: true });
    symlinkSync(outside, join(root, "src"));
    writeFileSync(join(root, "tmp", "one.txt"), "Edits: 5\n");
    const changes = await collectChanges(before!);
    expect(changes?.files.map((file) => file.path)).toEqual(["tmp/one.txt"]);
    expect(JSON.stringify(changes)).not.toContain("secret");
  });
});

/** A repository whose files git stores with LF and checks out with CRLF, as `configure` sets it up. */
function crlfRepository(configure: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "pi-ui-crlf-"));
  repos.push(root);
  git(root, "init", "-q");
  configure(root);
  writeFileSync(join(root, "notes.txt"), "one\ntwo\nthree\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  rmSync(join(root, "notes.txt"));
  git(root, "checkout", "-q", "notes.txt");
  expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
  return root;
}

describe("line ends git converts on checkout", () => {
  for (const [name, configure] of [
    ["core.autocrlf", (root: string) => git(root, "config", "core.autocrlf", "true")],
    ["an eol=crlf attribute", (root: string) => writeFileSync(join(root, ".gitattributes"), "*.txt text eol=crlf\n")],
  ] as const) {
    test(`with ${name}, a file rewritten with its own bytes shows no change`, async () => {
      const root = crlfRepository(configure);
      const before = await takeSnapshot(root);
      await tick();
      writeFileSync(join(root, "notes.txt"), "one\r\ntwo\r\nthree\r\n");
      expect(await collectChanges(before!)).toBeUndefined();
    });

    test(`with ${name}, an edit shows only the line it changed`, async () => {
      const root = crlfRepository(configure);
      const before = await takeSnapshot(root);
      await tick();
      writeFileSync(join(root, "notes.txt"), "one\r\nTWO\r\nthree\r\n");
      const patch = (await collectChanges(before!))?.files[0]?.patch ?? "";
      const changed = patch.split("\n").filter((line) => /^[+-](?![+-])/.test(line));
      expect(changed.map((line) => line.replace("\r", ""))).toEqual(["-two", "+TWO"]);
    });
  }
});

describe("old contents are read only for the files shown", () => {
  test("a tracked file past the per-file cap is never read from git", async () => {
    const root = repository();
    commit(root, { "asset.txt": "x\n".repeat(200_000) });
    const id = blobOf(root, "asset.txt");
    const before = await takeSnapshot(root);
    await tick();
    writeFileSync(join(root, "asset.txt"), "small now\n");
    const { spy, calls, read } = recording();
    const changes = await collectChanges(before!, spy);
    expect(changes?.files).toEqual([{ path: "asset.txt", kind: "modified", note: "too large" }]);
    expect(read()).not.toContain(id);
    expect(Math.max(...calls.map((call) => call.bytes))).toBeLessThan(10_000);
  });

  test("a deleted file's old contents are not read", async () => {
    const root = repository();
    commit(root, { "asset.txt": "x\n".repeat(200_000) });
    const before = await takeSnapshot(root);
    unlinkSync(join(root, "asset.txt"));
    unlinkSync(join(root, "src", "gone.ts"));
    const { spy, calls } = recording();
    const changes = await collectChanges(before!, spy);
    expect(changes?.files.map(({ path, kind }) => `${kind} ${path}`)).toEqual([
      "deleted asset.txt",
      "deleted src/gone.ts",
    ]);
    expect(calls.filter((call) => call.args[0] === "cat-file")).toEqual([]);
  });

  test("past the listing cap, the files counted are not read", async () => {
    const root = repository();
    const names = Array.from({ length: 60 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
    commit(root, Object.fromEntries(names.map((name) => [name, `${name} before\n`])));
    const before = await takeSnapshot(root);
    await tick();
    for (const name of names) writeFileSync(join(root, name), `${name} after\n`);
    const { spy, read } = recording();
    const changes = await collectChanges(before!, spy);
    expect(changes?.files).toHaveLength(LIMITS.maxListed);
    expect(changes?.more).toBe(10);
    expect(read().toSorted()).toEqual(
      names
        .slice(0, LIMITS.maxListed)
        .map((name) => blobOf(root, name))
        .toSorted(),
    );
  });

  test("files rewritten with the same bytes leave their place in the listing to the next ones", async () => {
    const root = repository();
    commit(root, { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" });
    const before = await takeSnapshot(root);
    await tick();
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, `${name}.txt`), `${name}\n`);
    writeFileSync(join(root, "d.txt"), "D\n");
    writeFileSync(join(root, "e.txt"), "e\n");
    const changes = await collectChanges(before!, runGit, undefined, { ...LIMITS, maxListed: 2 });
    expect(changes).toEqual({
      files: [
        { path: "d.txt", kind: "modified", patch: expect.stringContaining("-d\n+D\n") },
        { path: "e.txt", kind: "created", patch: expect.stringContaining("+e\n") },
      ],
    });
  });

  test("old contents read from git stop at their total cap", async () => {
    const root = repository();
    commit(root, { "a.txt": "a\n".repeat(500), "b.txt": "b\n".repeat(500), "c.txt": "c\n".repeat(500) });
    const before = await takeSnapshot(root);
    await tick();
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, `${name}.txt`), `${name}\n`.repeat(501));
    const { spy, read } = recording();
    const changes = await collectChanges(before!, spy, undefined, { ...LIMITS, maxBlobBytes: 2500 });
    expect(changes?.files.map((file) => file.note ?? "patch")).toEqual(["patch", "patch", "too large"]);
    expect(read()).not.toContain(blobOf(root, "c.txt"));
  });

  test("git's output past the reader's cap is cut off, and the call fails", async () => {
    const root = repository();
    commit(root, { "asset.txt": "x\n".repeat(200_000) });
    const id = blobOf(root, "asset.txt");
    expect((await runGit(["cat-file", "--batch"], root, 5000, `${id}\n`))?.length).toBeGreaterThan(400_000);
    const started = performance.now();
    expect(await runGit(["cat-file", "--batch"], root, 5000, `${id}\n`, 1000)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

/** `count` numbered lines, each starting with `tag`. */
const lines = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n");

describe("the diff's cost", () => {
  test("a patch reads as pi's own, the one its edit tool records", () => {
    const cases: Array<[string, string]> = [
      ["", lines(12_000, "a")],
      [lines(8000, "a"), ""],
      [lines(8000, "a"), lines(8000, "a").replace("a 100\n", "A 100\n")],
      ["one\ntwo\nthree", "one\nTWO\nthree\nfour"],
      ["crlf\r\nline\r\n", "crlf\r\nLINE\r\n"],
      ["same\n", "same"],
    ];
    for (const [before, after] of cases)
      expect(boundedPatch("dir/file.ts", before, after)).toBe(
        coding.generateUnifiedPatch("dir/file.ts", before, after),
      );
  });

  test("scattered edits across a large file are diffed", () => {
    const edited = lines(8000, "a")
      .split("\n")
      .map((line, index) => (index % 1000 === 0 ? line.toUpperCase() : line))
      .join("\n");
    expect(boundedPatch("f", lines(8000, "a"), edited)).toContain("+A 1000\n");
  });

  test("a new file, or a long block added to one, diffs whatever its length within the patch budget", () => {
    expect(boundedPatch("f", "", lines(20_000, "a"))).toContain("@@ -0,0 +1,20000 @@\n");
    expect(boundedPatch("f", lines(100, "a"), `${lines(100, "a")}\n${lines(15_000, "b")}`)).toContain("+b 14999");
  });

  test("a diff that would stall the session gives up within its bound", () => {
    // Reordering keeps every line, so no estimate from counts sees it: unbounded, jsdiff took over 25 s.
    const reversed = lines(12_000, "a").split("\n").toReversed().join("\n");
    const started = performance.now();
    expect(boundedPatch("f", lines(12_000, "a"), reversed)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
    expect(boundedPatch("f", lines(8000, "a"), lines(8000, "b"))).toBeUndefined();
  });

  test("a file whose diff gives up is reported without one", async () => {
    const root = repository();
    writeFileSync(join(root, "long.txt"), `${lines(12_000, "a")}\n`);
    git(root, "add", "long.txt");
    git(root, "commit", "-q", "-m", "long");
    const before = await takeSnapshot(root);
    await tick();
    writeFileSync(join(root, "long.txt"), `${lines(12_000, "a").split("\n").toReversed().join("\n")}\n`);
    writeFileSync(join(root, "clean.txt"), "one\nTWO\nthree\n");
    const changes = await collectChanges(before!);
    expect(changes?.files.find((file) => file.path === "long.txt")).toEqual({
      path: "long.txt",
      kind: "modified",
      note: "too large",
    });
    expect(changes?.files.find((file) => file.path === "clean.txt")?.patch).toBe(
      coding.generateUnifiedPatch("clean.txt", "one\ntwo\nthree\n", "one\nTWO\nthree\n"),
    );
  });
});

describe("recorded changes", () => {
  test("only well-formed records are read back", () => {
    expect(recordedChanges(undefined)).toBeUndefined();
    expect(recordedChanges({ piUiChanges: { files: "nope" } })).toBeUndefined();
    expect(
      recordedChanges({
        piUiChanges: { files: [{ path: "a", kind: "modified", patch: "p" }, { path: 3 }, null], more: 2 },
      }),
    ).toEqual({ files: [{ path: "a", kind: "modified", patch: "p" }], more: 2 });
  });

  test("a result saved before the rename to pi-ui is read from its old key", () => {
    const files = [{ path: "a", kind: "created" as const, patch: "p" }];
    expect(recordedChanges({ prismChanges: { files } })).toEqual({ files });
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
    )) as { details: { fullOutputPath: string; piUiChanges: unknown } };
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

  test("a file a sibling edit or write changes while the command runs is not the command's", async () => {
    const root = repository();
    const fire = hooks();
    const ctx = { mode: "tui", cwd: root };
    // In flight before the command starts: an absolute path.
    await fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: join(root, "clean.txt") } }, ctx);
    await fire("tool_call", { toolName: "bash", toolCallId: "1", input: {} }, ctx);
    // Started while it runs: a path relative to the working directory, nested in another tool.
    await fire(
      "tool_call",
      { toolName: "edit", toolCallId: "e", parentToolCallId: "c", input: { path: "src/gone.ts" } },
      ctx,
    );
    await tick();
    writeFileSync(join(root, "clean.txt"), "written by the sibling\n");
    writeFileSync(join(root, "src", "gone.ts"), "edited by the sibling\n");
    writeFileSync(join(root, "tmp", "one.txt"), "Edits: 5\n");
    const result = (await fire("tool_result", { toolName: "bash", toolCallId: "1" }, ctx)) as { details: unknown };
    expect(recordedChanges(result.details)?.files.map((file) => file.path)).toEqual(["tmp/one.txt"]);
  });

  test("an edit that ended before the command started is not left out", async () => {
    const root = repository();
    const fire = hooks();
    const ctx = { mode: "tui", cwd: root };
    await fire("tool_call", { toolName: "edit", toolCallId: "e", input: { path: "clean.txt" } }, ctx);
    await fire("tool_execution_end", { toolName: "edit", toolCallId: "e" }, ctx);
    await fire("tool_call", { toolName: "bash", toolCallId: "1", input: {} }, ctx);
    await tick();
    writeFileSync(join(root, "clean.txt"), "written by the command\n");
    const result = (await fire("tool_result", { toolName: "bash", toolCallId: "1" }, ctx)) as { details: unknown };
    expect(recordedChanges(result.details)?.files.map((file) => file.path)).toEqual(["clean.txt"]);
  });

  test("a snapshot that overruns its deadline records nothing and lets the command run", async () => {
    const fire = hooks({ git: hung, limits: { ...LIMITS, deadlineMs: 20 } });
    const started = performance.now();
    await fire("tool_call", { toolName: "bash", toolCallId: "1" }, { mode: "tui", cwd: "/" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(await fire("tool_result", { toolName: "bash", toolCallId: "1" })).toBeUndefined();
  });
});
