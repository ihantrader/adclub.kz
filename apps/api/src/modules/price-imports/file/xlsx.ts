import sax from "sax";
import type { PriceCell } from "@adclub/domain";
import { PriceFileError } from "../price-import-errors";
import { MAX_CELL_LENGTH, MAX_COLUMNS, tableLike, type FileRow, type RowSink } from "./rows";
import { readEntry, streamEntry, zipEntries, type ZipEntry } from "./zip";

/**
 * Reading an `.xlsx` (TASK-046 requirement 2; ARCHITECTURE 4.66): the ZIP
 * container by hand (`zip.ts`) and its XML with `sax` — a sheet is inflated
 * and parsed as a stream, rows go to the sink as they come.
 *
 * - The sheet: the first visible one with a row of two or more filled
 *   cells; a sheet with nothing like a table (an empty one, a title alone)
 *   is passed over for the next.
 * - Values, not formats: a number stays a number (`12500`, not
 *   «12 500,00 ₸»), a date (a number in a date format) becomes an ISO date,
 *   a formula gives its cached value, a boolean is `TRUE`/`FALSE`, an error
 *   (`#N/A`) is empty.
 * - Merged cells: the value of a range spanning several rows is put into
 *   every row of it (a brand merged over its goods belongs to each of them);
 *   one spanning columns of one row keeps the value in its first cell only
 *   (a title over the table is one cell, not six).
 */

/** The most an entry may unpack into: a sheet of 200 000 rows is far below it. */
const SHEET_CEILING = 512 * 1024 * 1024;
const SMALL_CEILING = 64 * 1024 * 1024;

interface Sheet {
  name: string;
  path: string;
}

interface Book {
  sheets: Sheet[];
  sharedStrings: string[];
  dateStyles: Set<number>;
  date1904: boolean;
}

function localName(name: string): string {
  const at = name.indexOf(":");
  return at >= 0 ? name.slice(at + 1) : name;
}

/** Parses a small XML document whole, calling `open`/`text`/`close` for its nodes. */
function parseXml(
  xml: string,
  handlers: {
    open?: (name: string, attributes: Record<string, string>) => void;
    text?: (text: string) => void;
    close?: (name: string) => void;
  },
): void {
  const parser = sax.parser(true, { trim: false, normalize: false, position: false });
  parser.onerror = (error) => {
    throw error;
  };
  parser.onopentag = (node) => {
    handlers.open?.(localName(node.name), node.attributes as Record<string, string>);
  };
  parser.ontext = (text) => handlers.text?.(text);
  parser.oncdata = (text) => handlers.text?.(text);
  parser.onclosetag = (name) => handlers.close?.(localName(name));
  try {
    parser.write(xml).close();
  } catch {
    throw new PriceFileError("broken", "The Excel file is damaged: its XML can't be read");
  }
}

function entryText(bytes: Buffer, entry: ZipEntry): string {
  return readEntry(bytes, entry, SMALL_CEILING).toString("utf8");
}

/** Resolves a relationship target against the folder of the part it belongs to. */
function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== "." && piece !== "") parts.push(piece);
  }
  return parts.join("/");
}

function relationships(bytes: Buffer, entries: Map<string, ZipEntry>, part: string) {
  const folder = part.split("/").slice(0, -1).join("/");
  const file = part.split("/").at(-1)!;
  const path = `${folder ? `${folder}/` : ""}_rels/${file}.rels`;
  const entry = entries.get(path);
  const map = new Map<string, { target: string; type: string }>();
  if (!entry) return map;
  parseXml(entryText(bytes, entry), {
    open(name, attributes) {
      if (name === "Relationship" && attributes.Id && attributes.Target) {
        map.set(attributes.Id, {
          target: resolvePath(part, attributes.Target),
          type: attributes.Type ?? "",
        });
      }
    },
  });
  return map;
}

/** Built-in number formats that are dates or times (ECMA-376 18.8.30). */
const BUILT_IN_DATES = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/** Whether a custom format code shows a date: d, m, y, h or s outside quotes, escapes and brackets. */
export function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "");
  if (/general/i.test(bare)) return false;
  return /[dmyhs]/i.test(bare);
}

function readStyles(bytes: Buffer, entries: Map<string, ZipEntry>, path: string | undefined) {
  const dates = new Set<number>();
  const entry = path ? entries.get(path) : undefined;
  if (!entry) return dates;
  const custom = new Map<number, string>();
  let inCellXfs = false;
  let index = 0;
  const formats: number[] = [];
  parseXml(entryText(bytes, entry), {
    open(name, attributes) {
      if (name === "numFmt" && attributes.numFmtId) {
        custom.set(Number(attributes.numFmtId), attributes.formatCode ?? "");
      } else if (name === "cellXfs") {
        inCellXfs = true;
      } else if (name === "xf" && inCellXfs) {
        formats[index++] = Number(attributes.numFmtId ?? 0);
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
  });
  formats.forEach((format, style) => {
    const code = custom.get(format);
    if (code !== undefined ? isDateFormat(code) : BUILT_IN_DATES.has(format)) dates.add(style);
  });
  return dates;
}

function readSharedStrings(
  bytes: Buffer,
  entries: Map<string, ZipEntry>,
  path: string | undefined,
) {
  const strings: string[] = [];
  const entry = path ? entries.get(path) : undefined;
  if (!entry) return strings;
  let current: string[] | null = null;
  let inText = false;
  let phonetic = 0;
  parseXml(entryText(bytes, entry), {
    open(name) {
      if (name === "si") current = [];
      else if (name === "rPh") phonetic++;
      else if (name === "t" && current && phonetic === 0) inText = true;
    },
    text(text) {
      if (inText && current) current.push(text);
    },
    close(name) {
      if (name === "t") inText = false;
      else if (name === "rPh") phonetic--;
      else if (name === "si" && current) {
        strings.push(current.join(""));
        current = null;
      }
    },
  });
  return strings;
}

function readBook(bytes: Buffer): { book: Book; entries: Map<string, ZipEntry> } {
  const entries = zipEntries(bytes);
  const root = relationships(bytes, entries, "");
  const office = [...root.values()].find((rel) => rel.type.endsWith("/officeDocument"));
  const workbookPath = office?.target ?? "xl/workbook.xml";
  const workbook = entries.get(workbookPath);
  if (!workbook) {
    // A ZIP that is not a workbook: a .docx, an .ods, an archive of anything.
    const detected = entries.has("word/document.xml")
      ? "docx"
      : entries.has("content.xml")
        ? "ods"
        : "zip";
    throw new PriceFileError("not_a_table", "This archive is not an Excel workbook", { detected });
  }
  const rels = relationships(bytes, entries, workbookPath);
  const listed: { name: string; id: string; hidden: boolean }[] = [];
  let date1904 = false;
  parseXml(entryText(bytes, workbook), {
    open(name, attributes) {
      if (name === "sheet") {
        const id =
          attributes["r:id"] ??
          Object.entries(attributes).find(([key]) => key.endsWith(":id"))?.[1];
        if (id) {
          listed.push({
            name: attributes.name ?? "",
            id,
            hidden: attributes.state === "hidden" || attributes.state === "veryHidden",
          });
        }
      } else if (name === "workbookPr") {
        date1904 = attributes.date1904 === "1" || attributes.date1904 === "true";
      }
    },
  });
  const ofType = (suffix: string) =>
    [...rels.values()].find((rel) => rel.type.endsWith(suffix))?.target;
  const sheets = listed
    .filter((sheet) => !sheet.hidden)
    .map((sheet) => ({ name: sheet.name, path: rels.get(sheet.id)?.target ?? "" }))
    .filter((sheet) => entries.has(sheet.path));
  return {
    entries,
    book: {
      sheets,
      sharedStrings: readSharedStrings(bytes, entries, ofType("/sharedStrings")),
      dateStyles: readStyles(bytes, entries, ofType("/styles")),
      date1904,
    },
  };
}

/** «B12» → column 1 (0-based); «AA3» → 26. */
export function columnIndex(reference: string): number {
  let column = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

function rowOf(reference: string): number {
  const digits = /\d+$/.exec(reference);
  return digits ? Number(digits[0]) : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An Excel serial date as an ISO date (with the time when it has one). */
export function excelDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial * DAY_MS));
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16);
}

interface Merge {
  firstRow: number;
  lastRow: number;
  column: number;
}

function parseMerge(reference: string): Merge | null {
  const [from, to] = reference.split(":");
  if (!from || !to) return null;
  const firstRow = rowOf(from);
  const lastRow = rowOf(to);
  if (lastRow <= firstRow) return null;
  return { firstRow, lastRow, column: columnIndex(from) };
}

/** Walks a sheet: rows to `onRow`, merged ranges to `onMerge`. */
async function walkSheet(
  bytes: Buffer,
  entry: ZipEntry,
  book: Book,
  onRow: (row: FileRow) => void,
  onMerge: ((merge: Merge) => void) | null,
  between: () => Promise<void>,
): Promise<void> {
  const parser = sax.parser(true, { trim: false, normalize: false, position: false });
  // sax only remembers an error until the next write; it is thrown at once instead.
  parser.onerror = (error) => {
    throw error;
  };
  const decoder = new TextDecoder("utf-8");
  let rowNo = 0;
  let cells: PriceCell[] = [];
  let column = -1;
  let type = "n";
  let style = 0;
  let value: string[] | null = null;
  let inline: string[] | null = null;
  let collect: string[] | null = null;
  let phonetic = 0;
  let inSheetData = false;
  let stopped: unknown = null;

  parser.onopentag = (node) => {
    const name = localName(node.name);
    const attributes = node.attributes as Record<string, string>;
    switch (name) {
      case "sheetData":
        inSheetData = true;
        break;
      case "row":
        rowNo = attributes.r ? Number(attributes.r) : rowNo + 1;
        cells = [];
        column = -1;
        break;
      case "c":
        column = attributes.r ? columnIndex(attributes.r) : column + 1;
        type = attributes.t ?? "n";
        style = Number(attributes.s ?? 0);
        value = null;
        inline = null;
        break;
      case "v":
        value = [];
        collect = value;
        break;
      case "is":
        inline = [];
        break;
      case "rPh":
        phonetic++;
        break;
      case "t":
        if (inline && phonetic === 0) collect = inline;
        break;
      case "mergeCell":
        if (onMerge && attributes.ref) {
          const merge = parseMerge(attributes.ref);
          if (merge) onMerge(merge);
        }
        break;
    }
  };
  parser.ontext = (text) => {
    collect?.push(text);
  };
  parser.oncdata = (text) => {
    collect?.push(text);
  };
  parser.onclosetag = (tag) => {
    const name = localName(tag);
    switch (name) {
      case "v":
      case "t":
        collect = null;
        break;
      case "rPh":
        phonetic--;
        break;
      case "c":
        if (column >= 0 && column < MAX_COLUMNS) {
          const cell = cellValue(
            type,
            style,
            value?.join("") ?? null,
            inline?.join("") ?? null,
            book,
          );
          if (cell !== null) cells[column] = cell;
        }
        break;
      case "row":
        if (stopped === null && inSheetData && cells.some((cell) => cell !== null)) {
          try {
            onRow({ rowNo, cells: Array.from(cells, (cell) => cell ?? null) });
          } catch (error) {
            // The sink's own refusal (too many rows): not a broken file.
            stopped = error;
          }
        }
        break;
      case "sheetData":
        inSheetData = false;
        break;
    }
  };

  const write = (text: string, close: boolean) => {
    try {
      parser.write(text);
      if (close) parser.close();
    } catch {
      throw new PriceFileError("broken", "The Excel file is damaged: its sheet can't be read");
    }
    if (stopped !== null) throw stopped;
  };
  // Errors of the sink's writes (the database) pass through as they are:
  // they are worth a retry, a broken file is not.
  await streamEntry(
    bytes,
    entry,
    SHEET_CEILING,
    (chunk) => write(decoder.decode(chunk, { stream: true }), false),
    between,
  );
  write(decoder.decode(), true);
}

function cellValue(
  type: string,
  style: number,
  value: string | null,
  inline: string | null,
  book: Book,
): PriceCell {
  let cell: PriceCell;
  switch (type) {
    case "s":
      cell = value === null ? null : (book.sharedStrings[Number(value)] ?? null);
      break;
    case "inlineStr":
      cell = inline ?? value;
      break;
    case "str":
      cell = value;
      break;
    case "b":
      cell = value === null ? null : value === "1" || value === "true" ? "TRUE" : "FALSE";
      break;
    case "e":
      cell = null;
      break;
    case "d":
      cell = value === null ? null : value.slice(0, 10);
      break;
    default: {
      if (value === null || value.trim() === "") return null;
      const number = Number(value);
      if (!Number.isFinite(number)) {
        cell = value;
      } else if (book.dateStyles.has(style)) {
        cell = excelDate(number, book.date1904);
      } else {
        cell = number;
      }
    }
  }
  if (typeof cell === "string") {
    const trimmed = cell.trim().slice(0, MAX_CELL_LENGTH);
    return trimmed === "" ? null : trimmed;
  }
  return cell;
}

/**
 * Reads the rows of an `.xlsx` into `sink`. Returns the sheet's name. A
 * workbook with no sheet like a table is `empty`; more non-empty rows than
 * `maxRows` on the chosen sheet is `too_many_rows` — found by the first
 * pass, before anything is written.
 */
export async function readXlsx(
  bytes: Buffer,
  maxRows: number,
  sink: RowSink,
): Promise<{ sheetName: string }> {
  const { book, entries } = readBook(bytes);
  for (const sheet of book.sheets) {
    const entry = entries.get(sheet.path)!;
    // The first pass: is it a table, how many rows, which ranges are merged
    // (they are listed after the rows, so a second pass fills them in).
    const merges: Merge[] = [];
    let rows = 0;
    let table = false;
    await walkSheet(
      bytes,
      entry,
      book,
      (row) => {
        rows++;
        if (!table && tableLike(row)) table = true;
      },
      (merge) => merges.push(merge),
      () => Promise.resolve(),
    );
    if (!table) continue;
    if (rows > maxRows) {
      throw new PriceFileError(
        "too_many_rows",
        `The sheet has ${String(rows)} rows; at most ${String(maxRows)} are taken at once`,
        { limit: maxRows },
      );
    }
    const byFirstRow = new Map<number, Merge[]>();
    for (const merge of merges) {
      byFirstRow.set(merge.firstRow, [...(byFirstRow.get(merge.firstRow) ?? []), merge]);
    }
    let open: { merge: Merge; value: PriceCell }[] = [];
    await walkSheet(
      bytes,
      entry,
      book,
      (row) => {
        open = open.filter((entry) => entry.merge.lastRow >= row.rowNo);
        for (const { merge, value } of open) {
          if (merge.firstRow < row.rowNo && (row.cells[merge.column] ?? null) === null) {
            row.cells[merge.column] = value;
          }
        }
        for (const merge of byFirstRow.get(row.rowNo) ?? []) {
          const value = row.cells[merge.column] ?? null;
          if (value !== null) open.push({ merge, value });
        }
        sink.row(row);
      },
      null,
      () => sink.flush(),
    );
    return { sheetName: sheet.name };
  }
  throw new PriceFileError("empty", "The workbook has no sheet with a table");
}

/**
 * The check of an upload: the archive opens, is a workbook, and its small
 * parts (the list of sheets, the styles, the shared strings) read; the
 * sheets themselves are left to the worker.
 */
export function checkXlsx(bytes: Buffer): void {
  readBook(bytes);
}
