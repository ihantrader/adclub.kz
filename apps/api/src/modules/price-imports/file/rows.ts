import { readPrice, type PriceCell } from "@adclub/domain";

/** Columns past this are not read (a price list has a dozen). */
export const MAX_COLUMNS = 100;

/** The longest cell kept. */
export const MAX_CELL_LENGTH = 1000;

/**
 * A row like one of a price list: two or more filled cells, one of them a
 * number (a price, a quantity). A letter whose lines a comma happens to
 * split, a title page of a workbook — no such row, no table.
 */
export function tableLike(row: FileRow): boolean {
  let filled = 0;
  let number = false;
  for (const cell of row.cells) {
    if (cell === null) continue;
    filled++;
    if (!number && readPrice(cell).kind === "price") number = true;
  }
  return filled >= 2 && number;
}

/** One non-empty row of a price file, numbered as the file numbers it. */
export interface FileRow {
  rowNo: number;
  cells: PriceCell[];
}

/**
 * Where a reader puts rows. `row` is called synchronously while the file is
 * parsed (it may throw to stop the reading — a refusal of the file passes
 * through as it is); `flush` is awaited between pieces of the file, so the
 * rows collected so far are written before more is parsed.
 */
export interface RowSink {
  row(row: FileRow): void;
  flush(): Promise<void>;
}
