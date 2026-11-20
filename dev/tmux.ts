/**
 * A tmux server of its own, driven from a script: commands, pane captures, waits for text, and
 * SGR mouse input sent as a terminal would send it. Shared by the end-to-end harness and the
 * replay driver.
 */

export interface Tmux {
  socket: string;
  session: string;
  /** Runs `tmux -L <socket> <args>`; its stdout, or an error with its stderr. */
  tmux(...args: string[]): string;
  /** The pane as plain text. */
  capture(): string;
  /** The pane with its SGR styling, every row padded to the pane's width. */
  captureStyled(): string;
  /** Every distinct pane from now until `text` shows, captured as fast as tmux answers: motion too quick for waitFor. */
  watch(text: string, timeoutMs?: number): Promise<string[]>;
  waitFor(text: string, timeoutMs?: number, ready?: (pane: string) => boolean): Promise<string>;
  /** SGR: 35 is motion with no button; 0 press/release is left click. Columns and rows count from 1. */
  mouse(button: number, column: number, row: number, release?: boolean): void;
}

export function tmuxSession(socket: string, session: string): Tmux {
  function tmux(...args: string[]): string {
    const result = Bun.spawnSync(["tmux", "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr.toString().trim()}`);
    return result.stdout.toString();
  }

  function capture(): string {
    return tmux("capture-pane", "-p", "-t", session);
  }

  function captureStyled(): string {
    return tmux("capture-pane", "-e", "-p", "-N", "-t", session);
  }

  async function watch(text: string, timeoutMs = 15_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const panes: string[] = [];
    for (;;) {
      const pane = capture();
      if (pane !== panes.at(-1)) panes.push(pane);
      if (pane.includes(text)) return panes;
      if (Date.now() > deadline) throw new Error(`timed out watching for ${JSON.stringify(text)}\n--- pane ---\n${pane}`);
      await Bun.sleep(1);
    }
  }

  async function waitFor(text: string, timeoutMs = 15_000, ready = (_pane: string) => true): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pane = capture();
      if (pane.includes(text) && ready(pane)) return pane;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}\n--- pane ---\n${pane}`);
      await Bun.sleep(200);
    }
  }

  function mouse(button: number, column: number, row: number, release = false): void {
    tmux("send-keys", "-l", "-t", session, `\x1b[<${button};${column};${row}${release ? "m" : "M"}`);
  }

  return { socket, session, tmux, capture, captureStyled, watch, waitFor, mouse };
}

/** The 1-based row of the first line holding `needle`. */
export function rowOf(pane: string, needle: string): number {
  const index = pane.split("\n").findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`row not found: ${needle}`);
  return index + 1;
}
