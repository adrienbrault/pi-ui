/**
 * An open group reads as a table: every member row starts its description in
 * the same column, whatever its label (think, bash, read, …), and lines its
 * numbers up on the right: out value, out rate, in value, in rate, duration,
 * each right-aligned to the widest cell among the members. The widths come
 * from every member's cells at once, so the two owners of member rows (tool
 * rows and thoughts) and the design system line up without measuring each
 * other's output.
 */

/** What one member row puts in the table's columns. A missing cell is blank. */
export interface MemberCells {
  label: string;
  /** Model output: a tool call's arguments, a thought's tokens. */
  outValue?: string;
  outRate?: string;
  /** Model input: a tool's result. Thoughts leave it blank. */
  inValue?: string;
  inRate?: string;
  duration?: string;
}

/** The width of each column across a group's member rows; 0 when no member fills it. */
export type MemberColumns = { [Column in keyof MemberCells]-?: number };

const COLUMNS = ["label", "outValue", "outRate", "inValue", "inRate", "duration"] as const;

export function memberColumns(cells: MemberCells[], measure: (text: string) => number): MemberColumns {
  const widths = { label: 0, outValue: 0, outRate: 0, inValue: 0, inRate: 0, duration: 0 };
  for (const cell of cells)
    for (const column of COLUMNS) widths[column] = Math.max(widths[column], measure(cell[column] ?? ""));
  return widths;
}

/** Spaces that fill a cell after its text. */
export function cellPadding(text: string, width: number, measure: (text: string) => number): string {
  return " ".repeat(Math.max(0, width - measure(text)));
}

/** One padded cell with its words around it; blank, it keeps the width. */
function paddedCell(text: string | undefined, width: number, before: string, after = ""): string {
  if (width === 0) return "";
  if (text === undefined) return " ".repeat(before.length + width + after.length);
  return before + " ".repeat(Math.max(0, width - text.length)) + text + after;
}

/**
 * The right-hand metrics of a member row, every cell padded to its column:
 * `out 26 @ 73/s · in 5.5k @ 2.5k/s · 1.2s`. A blank cell keeps its width,
 * words and separators included, so the next column still lines up.
 */
export function metricColumns(cells: MemberCells, columns: MemberColumns): string {
  return [
    paddedCell(cells.outValue, columns.outValue, "out "),
    paddedCell(cells.outRate, columns.outRate, " @ ", "/s"),
    paddedCell(cells.inValue, columns.inValue, " · in "),
    paddedCell(cells.inRate, columns.inRate, " @ ", "/s"),
    paddedCell(cells.duration, columns.duration, " · "),
  ]
    .join("")
    .replace(/^ \u00b7 /, "");
}
