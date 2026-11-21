/**
 * An open group reads as a table: every member row starts its description in
 * the same column, whatever its label (think, bash, read, …), and lines its
 * numbers up on the right: in value, in rate, out value, out rate, duration,
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

/** Which column words a table row writes: `out` before the output column, `in` before the input column. */
export interface ColumnLabels {
  out: boolean;
  in: boolean;
}

export const ALL_LABELS: ColumnLabels = { out: true, in: true };

/**
 * Each column's word sits on the first row that fills that column; the rows under it carry only
 * numbers. A thought fills no input column, so `in` waits for the first tool row.
 */
export function columnLabelRows(rows: MemberCells[]): ColumnLabels[] {
  let out = false;
  let input = false;
  return rows.map((cells) => {
    const labels = { out: !out && cells.outValue !== undefined, in: !input && cells.inValue !== undefined };
    out ||= labels.out;
    input ||= labels.in;
    return labels;
  });
}

/** A column word, or spaces of its width on a row that leaves it out. */
function word(text: string, shown: boolean): string {
  return shown ? text : " ".repeat(text.length);
}

/**
 * The words before the output column: ` · out ` after a written input, `out ` where the table has
 * no input columns, and spaces of the same width on a row that names neither.
 */
function outWords(cells: MemberCells, columns: MemberColumns, labels: ColumnLabels): string {
  const separator = columns.inValue || columns.inRate ? (labels.in && cells.inValue !== undefined ? " · " : "   ") : "";
  return labels.out ? `${separator}out ` : " ".repeat(separator.length + 4);
}

/** One padded cell with its words around it; blank, it keeps the width. */
function paddedCell(text: string | undefined, width: number, before: string, after = ""): string {
  if (width === 0) return "";
  if (text === undefined) return " ".repeat(before.length + width + after.length);
  return before + " ".repeat(Math.max(0, width - text.length)) + text + after;
}

/**
 * The right-hand metrics of a table row, every cell padded to its column:
 * `in 5.5k @ 2.5k/s · out 26 @ 73/s · 1.2s`. A blank cell keeps its width,
 * words and separators included, so the next column still lines up.
 * A column word a row leaves out is spaces of the same width, and so is the
 * separator before the duration on a row that writes no word: the first row
 * filling a column names it (`columnLabelRows`), the rows under it carry only
 * numbers.
 */
export function metricColumns(cells: MemberCells, columns: MemberColumns, labels: ColumnLabels = ALL_LABELS): string {
  return [
    // Input first: a thought leaves it blank, and every row's output then lines up on the right.
    paddedCell(cells.inValue, columns.inValue, word("in ", labels.in)),
    paddedCell(cells.inRate, columns.inRate, " @ ", "/s"),
    // The dot parts the two words when the row writes both; a thought's `out` stands alone.
    paddedCell(cells.outValue, columns.outValue, outWords(cells, columns, labels)),
    paddedCell(cells.outRate, columns.outRate, " @ ", "/s"),
    // A dot follows a named output, as in a standalone header; under it, numbers stand apart by spaces.
    paddedCell(cells.duration, columns.duration, word(" · ", labels.out)),
  ]
    .join("")
    .replace(/^ \u00b7 /, "");
}

/** Columns a member row's description keeps before the group's table gives way. */
export const MIN_DESCRIPTION = 16;

/**
 * Whether member rows this wide have room for the table beside a description:
 * one answer for the whole group, so either every row shows its numbers or
 * none does. A row is a glyph, the label column, ` · `, the description,
 * ` · ` and the table.
 */
export function tableFits(columns: MemberColumns, width: number): boolean {
  const table = metricColumns({ label: "" }, columns).length;
  return width - (2 + columns.label + 3) - MIN_DESCRIPTION - 3 - table >= 0;
}
