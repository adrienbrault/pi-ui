/**
 * Resolve the pi install the golden fixtures and `ds:show` render against.
 *
 * Order: explicit env, the repo-local install pinned in pi-ui's
 * devDependencies, then the newest nvm global install, then homebrew/system
 * globals. The pinned copy comes first so `ds:check` gives the same answer on
 * every machine and in CI; set `PI_CODING_AGENT_ROOT` to render against another
 * install.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface PiInstall {
  root: string;
  tuiRoot: string;
  version: string;
  tuiVersion: string;
  source: "env" | "nvm" | "global" | "local";
  modules: PiModules;
}

/** Dynamically loaded pi modules. Typed loosely: the harness renders, it does not build the product. */
export interface PiModules {
  coding: any;
  tui: any;
  theme: any;
}

const PKG = "@earendil-works/pi-coding-agent";

function packageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function nvmInstall(): string | undefined {
  const versions = join(homedir(), ".nvm", "versions", "node");
  if (!existsSync(versions)) return undefined;
  const candidates = readdirSync(versions)
    .toSorted()
    .toReversed()
    .map((entry) => join(versions, entry, "lib", "node_modules", PKG));
  return candidates.find((candidate) => existsSync(join(candidate, "dist", "index.js")));
}

function resolveRoot(): { root: string; source: PiInstall["source"] } {
  const env = process.env.PI_CODING_AGENT_ROOT;
  if (env && existsSync(join(env, "dist", "index.js"))) return { root: env, source: "env" };

  try {
    return { root: packageRoot(PKG, WORKSPACE), source: "local" };
  } catch {
    // Dependencies not installed: fall back to whatever this machine has.
  }

  const fromNvm = nvmInstall();
  if (fromNvm) return { root: fromNvm, source: "nvm" };

  for (const prefix of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    const candidate = join(prefix, PKG);
    if (existsSync(join(candidate, "dist", "index.js"))) return { root: candidate, source: "global" };
  }

  throw new Error(`${PKG} not found: run \`bun install\` or set PI_CODING_AGENT_ROOT`);
}

/** The root of the pi install the fixtures render against: the same order as `resolvePi`. */
export function piInstallRoot(): string {
  return resolveRoot().root;
}

const WORKSPACE = join(import.meta.dir, "../../packages/pi-ui");

function packageRoot(name: string, from: string): string {
  // Both pi packages expose dist/index.js as their entry point.
  return dirname(dirname(Bun.resolveSync(name, from)));
}

function resolveTuiRoot(piRoot: string): string {
  const name = "@earendil-works/pi-tui";
  try {
    return packageRoot(name, realpathSync(piRoot));
  } catch {
    return packageRoot(name, WORKSPACE);
  }
}

async function imp(path: string): Promise<any> {
  return import(pathToFileURL(path).href);
}

let cached: Promise<PiInstall> | undefined;

export async function resolvePi(): Promise<PiInstall> {
  cached ??= loadPi();
  return cached;
}

async function loadPi(): Promise<PiInstall> {
  const { root, source } = resolveRoot();
  const tuiRoot = resolveTuiRoot(root);
  const modules: PiModules = {
    coding: await imp(join(root, "dist", "index.js")),
    tui: await imp(join(tuiRoot, "dist", "index.js")),
    theme: await imp(join(root, "dist", "modes", "interactive", "theme", "theme.js")),
  };
  return {
    root,
    tuiRoot,
    version: packageVersion(root),
    tuiVersion: packageVersion(tuiRoot),
    source,
    modules,
  };
}
