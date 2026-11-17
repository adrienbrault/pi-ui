/**
 * Resolve the pi install this machine actually runs, so the gallery shows truth
 * rather than a pinned approximation.
 *
 * Order: explicit env, the newest nvm global install, homebrew/system globals,
 * then a repo-local install.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  exportHtml: any;
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

  const fromNvm = nvmInstall();
  if (fromNvm) return { root: fromNvm, source: "nvm" };

  for (const prefix of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    const candidate = join(prefix, PKG);
    if (existsSync(join(candidate, "dist", "index.js"))) return { root: candidate, source: "global" };
  }

  const local = join(process.cwd(), "node_modules", PKG);
  if (existsSync(join(local, "dist", "index.js"))) return { root: local, source: "local" };

  throw new Error(`Cannot find ${PKG}. Set PI_CODING_AGENT_ROOT to the package root, or install it locally.`);
}

function resolveTuiRoot(piRoot: string): string {
  const nested = join(piRoot, "node_modules", "@earendil-works", "pi-tui");
  if (existsSync(join(nested, "dist", "index.js"))) return nested;
  const local = join(process.cwd(), "node_modules", "@earendil-works", "pi-tui");
  if (existsSync(join(local, "dist", "index.js"))) return local;
  throw new Error(`Cannot find @earendil-works/pi-tui next to ${piRoot}.`);
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
    exportHtml: await imp(join(root, "dist", "core", "export-html", "ansi-to-html.js")),
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

/** Installed extension packages (pi-code, pi-open-tui) live in the agent dir. */
export function agentPackageRoot(name: string): string | undefined {
  const candidate = join(homedir(), ".pi", "agent", "npm", "node_modules", name);
  return existsSync(candidate) ? candidate : undefined;
}
