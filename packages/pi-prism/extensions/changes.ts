/**
 * Files a shell command changed in its git work tree, recorded on the tool result so the row
 * can show their diffs under the output, as Claude Code does, and a reloaded session still can.
 *
 * Before the command runs (`tool_call`, awaited by pi, after the row has started painting), a
 * snapshot lists the work tree's files (`git ls-files`: tracked, and untracked but not ignored),
 * stats each one, notes each tracked file's blob in the index, and reads the content of the files
 * git does not hold as they are: untracked files, and tracked files that differ from the index.
 * After the command (`tool_result`, which can add `details`), the files whose stat changed are
 * diffed old to new with pi's own patch helper. Nothing is written to the repository: every git
 * call takes `--no-optional-locks`, and none of them creates objects or touches the index.
 *
 * Everything is bounded: git calls and the snapshot have a deadline, reads have per-file and
 * total caps, and a repository with too many files is skipped. Any failure skips quietly.
 */

import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import * as coding from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolMeta } from "../render/tools.ts";
import type { FileChange, FileChanges } from "../render/tool-row.ts";

/** Runs git in `cwd`; its stdout, or undefined when git is missing, fails or overruns `timeout`. */
export type Git = (args: string[], cwd: string, timeout: number, input?: string) => Promise<Buffer | undefined>;

/** A unified patch from `before` to `after`, headed by `path`. */
export type Patch = (path: string, before: string, after: string) => string;

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
}

export const LIMITS: Limits = {
  deadlineMs: 1000,
  maxFiles: 20_000,
  maxFileBytes: 256 * 1024,
  maxSavedBytes: 4 * 1024 * 1024,
  maxSavedFiles: 2000,
  maxListed: 50,
  maxPatchBytes: 256 * 1024,
};

export const runGit: Git = (args, cwd, timeout, input) =>
  new Promise((resolve) => {
    const options = { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } };
    const argv = ["--no-optional-locks", ...args];
    if (input === undefined) {
      execFile("git", argv, { ...options, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
        resolve(error ? undefined : stdout),
      );
      return;
    }
    const child = spawn("git", argv, { ...options, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
    child.stdin.end(input);
  });

/** pi's patch helper, the one its edit tool uses; guarded, since older installs may lack it. */
const piPatch: Patch | undefined =
  typeof (coding as { generateUnifiedPatch?: unknown }).generateUnifiedPatch === "function"
    ? (path, before, after) => coding.generateUnifiedPatch(path, before, after)
    : undefined;

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

/** The blobs' contents by id, through one `git cat-file --batch`. */
async function readBlobs(git: Git, root: string, ids: string[], timeout: number): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  if (!ids.length) return blobs;
  const output = await git(["cat-file", "--batch"], root, timeout, `${ids.join("\n")}\n`);
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
  patch: Patch | undefined = piPatch,
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

  const held = changed.flatMap(({ path, kind }) => {
    const id = kind !== "created" && !snapshot.saved.has(path) ? snapshot.blobs.get(path) : undefined;
    return id ? [id] : [];
  });
  const blobs = await readBlobs(git, root, [...new Set(held)], remaining(deadline));
  const files: FileChange[] = [];
  let more = 0;
  let patchBytes = 0;
  for (const { path, kind, size } of changed) {
    if (files.length >= limits.maxListed || Date.now() > deadline) {
      more += 1;
      continue;
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
    // In path order, one at a time: the loop stops at the listing cap, and the patch budget goes in order.
    // oxlint-disable-next-line no-await-in-loop
    if (size <= limits.maxFileBytes) after = await readFile(join(root, path)).catch(() => undefined);
    // Touched, rewritten with the same bytes: nothing changed that a diff could show.
    if (before && after && before.equals(after)) continue;
    if (!before || !after || !patch) {
      files.push({ path: shown, kind, note: "too large" });
      continue;
    }
    if (binary(before) || binary(after)) {
      files.push({ path: shown, kind, note: "binary" });
      continue;
    }
    const text = patch(shown, before.toString("utf8"), after.toString("utf8"));
    if (patchBytes + text.length > limits.maxPatchBytes) {
      files.push({ path: shown, kind, note: "too large" });
      continue;
    }
    patchBytes += text.length;
    files.push({ path: shown, kind, patch: text });
  }
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
  const patch = options.patch ?? piPatch;
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
