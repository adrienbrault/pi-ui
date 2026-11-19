/**
 * Files a shell command changed in its git work tree, recorded on the tool result so the row
 * can show their diffs under the output, as Claude Code does, and a reloaded session still can.
 *
 * Before the command runs (`tool_call`, awaited by pi, after the row has started painting), a
 * snapshot lists the work tree's files (`git ls-files`: tracked, and untracked but not ignored),
 * stats each one, notes each tracked file's blob in the index, and reads the content of the files
 * git does not hold as they are: untracked files, and tracked files that differ from the index.
 * After the command (`tool_result`, which can add `details`), the files whose stat changed are
 * diffed old to new as pi's edit tool diffs, with a bound on the diff's work. Nothing is written to the repository: every git
 * call takes `--no-optional-locks`, and none of them creates objects or touches the index.
 *
 * Everything is bounded: git calls and the snapshot have a deadline, reads have per-file and
 * total caps, each diff has a time and an edit-length bound, and a repository with too many files
 * is skipped. Any failure skips quietly.
 */

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolMeta } from "../render/tools.ts";
import type { FileChange, FileChanges } from "../render/tool-row.ts";

/**
 * Runs git in `cwd`; its stdout, or undefined when git is missing, fails, overruns `timeout` or
 * writes more than `maxBytes`.
 */
export type Git = (
  args: string[],
  cwd: string,
  timeout: number,
  input?: string,
  maxBytes?: number,
) => Promise<Buffer | undefined>;

/** A unified patch from `before` to `after`, headed by `path`; undefined when it would take longer than `timeoutMs`. */
export type Patch = (path: string, before: string, after: string, timeoutMs: number) => string | undefined;

export interface Limits {
  /** The snapshot before a command, and the collection after it, each finish within this. */
  deadlineMs: number;
  /** A work tree with more candidate files than this is skipped. */
  maxFiles: number;
  /** A file larger than this has its change reported without a diff. */
  maxFileBytes: number;
  /** Content read before a command, across files: past it, changes are reported without diffs. */
  maxSavedBytes: number;
  maxSavedFiles: number;
  /** Files recorded on one result; the rest are counted. */
  maxListed: number;
  /** Patch text recorded on one result, across files. */
  maxPatchBytes: number;
  /** Old content read from git after a command, across files: past it, changes are reported without diffs. */
  maxBlobBytes: number;
}

export const LIMITS: Limits = {
  deadlineMs: 1000,
  maxFiles: 20_000,
  maxFileBytes: 256 * 1024,
  maxSavedBytes: 4 * 1024 * 1024,
  maxSavedFiles: 2000,
  maxListed: 50,
  maxPatchBytes: 256 * 1024,
  maxBlobBytes: 4 * 1024 * 1024,
};

/** What one git call may write before it is stopped: a listing of `maxFiles` paths fits many times over. */
const GIT_MAX_BYTES = 64 * 1024 * 1024;

export const runGit: Git = (args, cwd, timeout, input, maxBytes = GIT_MAX_BYTES) =>
  new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd,
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (output: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      resolve(output);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      // Past the cap nothing more is read: the call fails and git is stopped.
      settle(undefined);
      child.kill();
    });
    child.on("error", () => settle(undefined));
    child.on("close", (code) => settle(code === 0 ? Buffer.concat(chunks) : undefined));
    // Killed mid-input, git closes its end of the pipe: the failed write is expected.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

/**
 * The diff's bounds. jsdiff's Myers search runs synchronously and a deadline cannot interrupt it:
 * reversing 12,000 lines took 53 s. Both bounds make jsdiff give up and return undefined. The time
 * is checked once per edit length; the edit-length bound (lines removed plus lines added) caps the
 * work of each of those steps, and turns away only edits whose patch could not fit the patch text
 * budget anyway, at two bytes or more per changed line. A new file of 32,000 short lines diffs in
 * about 30 ms, within the time.
 */
export const PATCH_TIMEOUT_MS = 50;
export const PATCH_MAX_EDIT_LINES = LIMITS.maxPatchBytes / 2;

/**
 * pi's `generateUnifiedPatch`, the helper its edit tool uses (jsdiff's two-file patch with file
 * headers only and four lines of context), with the diff's bounds added.
 */
export function boundedPatch(
  path: string,
  before: string,
  after: string,
  timeoutMs = PATCH_TIMEOUT_MS,
): string | undefined {
  return createTwoFilesPatch(path, path, before, after, undefined, undefined, {
    context: 4,
    headerOptions: FILE_HEADERS_ONLY,
    timeout: timeoutMs,
    maxEditLength: PATCH_MAX_EDIT_LINES,
  });
}

/** A work tree before a command: paths are relative to its top level. */
export interface Snapshot {
  root: string;
  /** The session's working directory under `root`, `dir/` or empty: paths are shown from there. */
  prefix: string;
  /** Size, mtime and inode of each regular candidate file. */
  stats: Map<string, string>;
  /** Each tracked file's blob in the index. */
  blobs: Map<string, string>;
  /** Content git does not hold, read before the command; null past a cap. */
  saved: Map<string, Buffer | null>;
}

const paths = (output: Buffer): string[] => output.toString("utf8").split("\0").filter(Boolean);

/** A regular file's identity for change detection; undefined for anything else or nothing. */
async function statKey(path: string): Promise<{ key: string; size: number } | undefined> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile()) return undefined;
    return { key: `${stat.size}:${stat.mtimeNs}:${stat.ino}`, size: Number(stat.size) };
  } catch {
    return undefined;
  }
}

/** Run `work` over `items`, a few at a time, so a large tree does not open every file at once. */
async function each<T>(items: T[], work: (item: T) => Promise<void>, width = 64): Promise<void> {
  for (let start = 0; start < items.length; start += width)
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time is the point
    await Promise.all(items.slice(start, start + width).map(work));
}

const remaining = (deadline: number) => Math.max(1, deadline - Date.now());

/** The work tree before a command; undefined outside a git work tree, past a limit or on failure. */
export async function takeSnapshot(
  cwd: string,
  git: Git = runGit,
  limits: Limits = LIMITS,
): Promise<Snapshot | undefined> {
  const deadline = Date.now() + limits.deadlineMs;
  // The top level and where `cwd` sits under it, as git spells them (it resolves symlinks).
  const top = await git(["rev-parse", "--show-toplevel", "--show-prefix"], cwd, remaining(deadline));
  const [root, prefix = ""] = top?.toString("utf8").split("\n") ?? [];
  if (!root) return undefined;
  const [staged, others, dirty] = await Promise.all([
    git(["ls-files", "-z", "--stage"], root, remaining(deadline)),
    git(["ls-files", "-z", "--others", "--exclude-standard"], root, remaining(deadline)),
    // Stat-only and filter-free: a file whose stat alone changed is read too, which costs only the read.
    git(["diff-files", "--name-only", "-z"], root, remaining(deadline)),
  ]);
  if (!staged || !others || !dirty) return undefined;
  const blobs = new Map<string, string>();
  for (const entry of paths(staged)) {
    // `<mode> <blob> <stage>\t<path>`: only regular files at stage 0 have one blob to diff against.
    const match = /^(100644|100755) ([0-9a-f]+) 0\t(.*)$/s.exec(entry);
    if (match) blobs.set(match[3]!, match[2]!);
  }
  const untracked = paths(others);
  const candidates = [...new Set([...blobs.keys(), ...untracked])];
  if (candidates.length > limits.maxFiles) return undefined;
  const stats = new Map<string, string>();
  const sizes = new Map<string, number>();
  await each(candidates, async (path) => {
    const stat = await statKey(join(root, path));
    if (!stat) return;
    stats.set(path, stat.key);
    sizes.set(path, stat.size);
  });
  // Git holds a clean tracked file's content; the rest must be read now, before the command writes.
  // Past a cap a file is still watched, and a change to it is reported without a diff.
  const unheld = [...new Set([...untracked, ...paths(dirty)])].filter((path) => stats.has(path)).toSorted();
  const saved = new Map<string, Buffer | null>();
  const reads: string[] = [];
  let bytes = 0;
  for (const path of unheld) {
    const size = sizes.get(path) ?? 0;
    saved.set(path, null);
    if (size > limits.maxFileBytes || bytes + size > limits.maxSavedBytes || reads.length >= limits.maxSavedFiles)
      continue;
    bytes += size;
    reads.push(path);
  }
  await each(reads, async (path) => {
    const content = await readFile(join(root, path)).catch(() => null);
    saved.set(path, content && content.length <= limits.maxFileBytes ? content : null);
  });
  if (Date.now() > deadline) return undefined;
  return { root, prefix, stats, blobs, saved };
}

/** Binary content: a NUL byte in its first 8000 bytes, as git decides. */
const binary = (content: Buffer) => content.subarray(0, 8000).includes(0);

/** Room for one object's header in `git cat-file` output: `<id> <type> <size>\n`, with its trailing newline. */
const HEADER_BYTES = 128;

/** The size of each blob among `ids`, through one `git cat-file --batch-check`; missing ids are left out. */
async function blobSizes(git: Git, root: string, ids: string[], timeout: number): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!ids.length) return sizes;
  const format = "--batch-check=%(objectname) %(objecttype) %(objectsize)";
  const output = await git(["cat-file", format], root, timeout, `${ids.join("\n")}\n`, ids.length * HEADER_BYTES);
  for (const line of output?.toString("utf8").split("\n") ?? []) {
    // `<id> blob <size>`, or `<id> missing`.
    const [id, type, size] = line.split(" ");
    if (id && type === "blob" && size) sizes.set(id, Number(size));
  }
  return sizes;
}

/** The blobs' contents by id, through one `git cat-file --batch` that may write no more than `sizes` add up to. */
async function readBlobs(
  git: Git,
  root: string,
  sizes: Map<string, number>,
  timeout: number,
): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  const ids = [...sizes.keys()];
  if (!ids.length) return blobs;
  const cap = ids.reduce((total, id) => total + HEADER_BYTES + (sizes.get(id) ?? 0), 0);
  const output = await git(["cat-file", "--batch"], root, timeout, `${ids.join("\n")}\n`, cap);
  if (!output) return blobs;
  let at = 0;
  for (const id of ids) {
    const end = output.indexOf(10, at);
    if (end < 0) break;
    // `<id> blob <size>\n<content>\n`, or `<id> missing\n`.
    const header = output.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    blobs.set(id, output.subarray(at, at + size));
    at += size + 1;
  }
  return blobs;
}

/** What changed since `snapshot`, with a patch per file where one can be shown; undefined for nothing. */
export async function collectChanges(
  snapshot: Snapshot,
  git: Git = runGit,
  patch: Patch = boundedPatch,
  limits: Limits = LIMITS,
): Promise<FileChanges | undefined> {
  const deadline = Date.now() + limits.deadlineMs;
  const { root } = snapshot;
  const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, remaining(deadline));
  if (!listed) return undefined;
  // A file deleted while untracked leaves the listing: the snapshot still names it.
  const candidates = [...new Set([...paths(listed), ...snapshot.stats.keys()])];
  if (candidates.length > limits.maxFiles) return undefined;
  const changed: Array<{ path: string; kind: FileChange["kind"]; size: number }> = [];
  await each(candidates, async (path) => {
    const now = await statKey(join(root, path));
    const before = snapshot.stats.get(path);
    if (now?.key === before) return;
    changed.push({ path, kind: !before ? "created" : !now ? "deleted" : "modified", size: now?.size ?? 0 });
  });
  if (!changed.length) return undefined;
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files: FileChange[] = [];
  let patchBytes = 0;
  let blobBytes = 0;
  /** The old contents git holds for `window`'s modified files, read only within the caps. */
  const readOld = async (window: typeof changed): Promise<Map<string, Buffer>> => {
    // A deleted file shows no patch; a file too large now, or once the patch text is spent, shows none either.
    if (patchBytes >= limits.maxPatchBytes) return new Map();
    const wanted = window.flatMap(({ path, kind, size }) => {
      const id =
        kind === "modified" && size <= limits.maxFileBytes && !snapshot.saved.has(path)
          ? snapshot.blobs.get(path)
          : undefined;
      return id ? [id] : [];
    });
    const sizes = await blobSizes(git, root, [...new Set(wanted)], remaining(deadline));
    const approved = new Map<string, number>();
    for (const [id, size] of sizes) {
      if (size > limits.maxFileBytes || blobBytes + size > limits.maxBlobBytes) continue;
      blobBytes += size;
      approved.set(id, size);
    }
    return readBlobs(git, root, approved, remaining(deadline));
  };
  // In path order, a window at a time: each takes as many files as the listing has room for, and
  // reads only those files' old contents. A file rewritten with the same bytes is not listed, and
  // its place goes to the next window.
  let next = 0;
  while (next < changed.length && files.length < limits.maxListed && Date.now() <= deadline) {
    const window = changed.slice(next, next + limits.maxListed - files.length);
    next += window.length;
    // oxlint-disable-next-line no-await-in-loop -- each window depends on how the last one filled the listing
    const blobs = await readOld(window);
    for (const [index, { path, kind, size }] of window.entries()) {
      if (Date.now() > deadline) {
        next -= window.length - index;
        break;
      }
      const shown = posix.relative(`/${snapshot.prefix}`, `/${path}`) || path;
      if (kind === "deleted") {
        files.push({ path: shown, kind });
        continue;
      }
      const before =
        kind === "created"
          ? Buffer.alloc(0)
          : snapshot.saved.has(path)
            ? snapshot.saved.get(path)
            : blobs.get(snapshot.blobs.get(path) ?? "");
      let after: Buffer | undefined;
      // One at a time, in path order: the patch budget goes in that order.
      // oxlint-disable-next-line no-await-in-loop
      if (size <= limits.maxFileBytes) after = await readFile(join(root, path)).catch(() => undefined);
      // Touched, rewritten with the same bytes: nothing changed that a diff could show.
      if (before && after && before.equals(after)) continue;
      if (!before || !after) {
        files.push({ path: shown, kind, note: "too large" });
        continue;
      }
      if (binary(before) || binary(after)) {
        files.push({ path: shown, kind, note: "binary" });
        continue;
      }
      // The diff runs synchronously, so it gets at most what is left of the deadline: one that would
      // stall the session gives up and is reported without it.
      const timeout = Math.min(PATCH_TIMEOUT_MS, remaining(deadline));
      const text = patch(shown, before.toString("utf8"), after.toString("utf8"), timeout);
      if (text === undefined || patchBytes + text.length > limits.maxPatchBytes) {
        files.push({ path: shown, kind, note: "too large" });
        continue;
      }
      patchBytes += text.length;
      files.push({ path: shown, kind, patch: text });
    }
  }
  const more = changed.length - next;
  if (!files.length && !more) return undefined;
  return { files, ...(more ? { more } : {}) };
}

/** The changed files recorded on a tool result's details, when they are well formed. */
export function recordedChanges(details: unknown): FileChanges | undefined {
  const recorded = (details as { prismChanges?: unknown } | undefined)?.prismChanges as
    | Partial<FileChanges>
    | undefined;
  if (!recorded || !Array.isArray(recorded.files)) return undefined;
  const files = recorded.files.filter(
    (file): file is FileChange =>
      !!file &&
      typeof file.path === "string" &&
      ["created", "modified", "deleted"].includes(file.kind) &&
      (file.patch === undefined || typeof file.patch === "string"),
  );
  const more = typeof recorded.more === "number" && recorded.more > 0 ? recorded.more : 0;
  return files.length || more ? { files, ...(more ? { more } : {}) } : undefined;
}

/**
 * Snapshot before each top-level shell call and record what it changed on its result. The
 * snapshot is awaited before the command runs, within its deadline; a call whose snapshot
 * fails or overruns records nothing.
 */
export function installFileChanges(
  pi: ExtensionAPI,
  options: { git?: Git; patch?: Patch; limits?: Limits } = {},
): void {
  const git = options.git ?? runGit;
  const patch = options.patch ?? boundedPatch;
  const limits = options.limits ?? LIMITS;
  const pending = new Map<string, Promise<Snapshot | undefined>>();
  pi.on("tool_call", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.parentToolCallId || toolMeta(event.toolName).cls !== "shell") return;
    const snapshot = Promise.race([
      takeSnapshot(ctx.cwd, git, limits).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, limits.deadlineMs + 50)),
    ]);
    pending.set(event.toolCallId, snapshot);
    // The command must not start writing before the snapshot has read what it needs.
    await snapshot;
  });
  pi.on("tool_result", async (event) => {
    const snapshot = pending.get(event.toolCallId);
    if (!snapshot) return undefined;
    pending.delete(event.toolCallId);
    try {
      const before = await snapshot;
      const changes = before ? await collectChanges(before, git, patch, limits) : undefined;
      if (!changes) return undefined;
      const details = event.details && typeof event.details === "object" ? event.details : {};
      return { details: { ...details, prismChanges: changes } };
    } catch {
      return undefined;
    }
  });
  // A call blocked before it ran has no result to record on.
  pi.on("tool_execution_end", (event) => {
    pending.delete(event.toolCallId);
  });
  pi.on("session_start", () => pending.clear());
  pi.on("session_shutdown", () => pending.clear());
}
