/** Source rows shown while a streaming thinking preview catches up to its newest lines. */
export interface TailWindow {
  rows: number[];
  total: number;
  keep: number;
}

export function planTailWindow(total: number, keep: number, previous?: TailWindow): TailWindow {
  keep = Math.max(1, Math.floor(keep));
  const size = Math.min(total, keep);
  const target = total - size;
  if (!previous || previous.keep !== keep || total < previous.total) {
    return { rows: Array.from({ length: size }, (_, i) => target + i), total, keep };
  }
  if (total === previous.total) return previous;
  // Retain visible rows awaiting erasure. Always expose the current streaming line.
  const rows = previous.rows.slice(0, Math.min(previous.rows.length, size - 1));
  for (let i = total - (size - rows.length); i < total; i++) rows.push(i);
  return { rows, total, keep };
}

export function isDropping(window: TailWindow): boolean {
  return (window.rows[0] ?? 0) < window.total - window.keep;
}

export function advanceTailWindow(window: TailWindow): TailWindow {
  if (!isDropping(window)) return window;
  const rows = window.rows.slice(1);
  let next = window.total - window.keep;
  while (rows.includes(next)) next++;
  rows.push(next);
  rows.sort((a, b) => a - b);
  return { ...window, rows };
}
