/**
 * Pane captures to files: asciicast v2 recordings, and PNG and GIF renders of them.
 *
 * A frame is `tmux capture-pane -e -p -N`: every row with its SGR styling and its trailing
 * blanks. In a cast, each frame redraws the whole screen from the top left with the cursor hidden.
 * `agg` renders a cast to a GIF; a PNG is the first frame of a one-frame GIF, through `ffmpeg`.
 */

export interface Frame {
  /** Seconds from the start of the recording. */
  time: number;
  pane: string;
}

/** agg's custom theme: background, foreground, then the 16 ANSI colours, as hex without `#`. */
export const AGG_THEMES: Record<string, string> = {
  dark: [
    "1e1e1e",
    "d4d4d4",
    "1e1e1e,cd3131,0dbc79,e5e510,2472c8,bc3fbc,11a8cd,e5e5e5",
    "666666,f14c4c,23d18b,f5f543,3b8eea,d670d6,29b8db,ffffff",
  ].join(","),
  light: [
    "ffffff",
    "1f1f1f",
    "000000,cd3131,00bc00,949800,0451a5,bc05bc,0598bc,555555",
    "666666,cd3131,14ce14,b5ba00,0451a5,bc05bc,0598bc,a5a5a5",
  ].join(","),
};

/**
 * One frame as terminal output: a cleared screen, then each row from a clean style, cursor hidden.
 * The clear matters: a captured row stops at its last written cell, short of the pane's width.
 */
export function frameOutput(pane: string): string {
  const rows = pane.replace(/\n$/, "").split("\n");
  return `\x1b[?25l\x1b[0m\x1b[H\x1b[2J${rows.map((row) => `\x1b[0m${row}`).join("\r\n")}\x1b[0m`;
}

export function asciicast(frames: Frame[], width: number, height: number): string {
  const header = { version: 2, width, height, env: { TERM: "xterm-256color" } };
  const events = frames.map((frame) => JSON.stringify([Number(frame.time.toFixed(3)), "o", frameOutput(frame.pane)]));
  return `${[JSON.stringify(header), ...events].join("\n")}\n`;
}

/** Drops each frame that repeats the one before it. */
export function distinct(frames: Frame[]): Frame[] {
  return frames.filter((frame, index) => index === 0 || frame.pane !== frames[index - 1]!.pane);
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
}

export interface RenderOptions {
  theme: string;
  fontSize: number;
}

export function renderGif(
  castPath: string,
  gifPath: string,
  options: RenderOptions & { lastFrameSeconds?: number },
): void {
  run([
    "agg",
    "--quiet",
    "--theme",
    AGG_THEMES[options.theme] ?? AGG_THEMES.dark!,
    "--font-size",
    String(options.fontSize),
    "--line-height",
    "1.2",
    "--idle-time-limit",
    "60",
    "--last-frame-duration",
    String(options.lastFrameSeconds ?? 3),
    castPath,
    gifPath,
  ]);
}

export function renderPng(castPath: string, gifPath: string, pngPath: string, options: RenderOptions): void {
  renderGif(castPath, gifPath, { ...options, lastFrameSeconds: 0.1 });
  run(["ffmpeg", "-loglevel", "error", "-y", "-i", gifPath, "-frames:v", "1", "-update", "1", pngPath]);
}
