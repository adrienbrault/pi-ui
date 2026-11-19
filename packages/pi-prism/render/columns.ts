/**
 * An open group reads as a table: every member row starts its description in
 * the same column, whatever its label (think, bash, read, …). The widths come
 * from every member's cells at once, so the two owners of member rows (tool
 * rows and thoughts) and the design system line up without measuring each
 * other's output.
 */

/** What one member row puts in the table's columns. */
export interface MemberCells {
  label: string;
}

/** The width of each column across a group's member rows. */
export interface MemberColumns {
  label: number;
}

export function memberColumns(cells: MemberCells[], measure: (text: string) => number): MemberColumns {
  return { label: cells.reduce((widest, cell) => Math.max(widest, measure(cell.label)), 0) };
}

/** Spaces that fill a cell after its text. */
export function cellPadding(text: string, width: number, measure: (text: string) => number): string {
  return " ".repeat(Math.max(0, width - measure(text)));
}
