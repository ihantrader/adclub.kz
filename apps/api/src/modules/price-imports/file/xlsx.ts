import sax from "sax";
import type { PriceCell } from "@adclub/domain";
import { PriceFileError } from "../price-import-errors";
import { MAX_CELL_LENGTH, MAX_COLUMNS, tableLike, type FileRow, type RowSink } from "./rows";
import { entryProblem, unpackBudget, ZipArchive, zipEntries, type ZipEntry } from "./zip";

/**
 * Reading an `.xlsx` (TASK-046 requirement 2, TASK-046.A; ARCHITECTURE
 * 4.66): the ZIP container by hand (`zip.ts`) and its XML with `sax` —
 * every part is inflated and parsed as a stream under the budget of the
 * file, rows go to the sink as they come, and between pieces the event
 * loop gets a turn (`between`), so a job's timeout and the worker's stop
 * reach a long reading.
 *
 * - The sheet: the first visible one with a row of two or more filled
 *   cells; a sheet with nothing like a table (an empty one, a title alone)
 *   is passed over for the next — unpacked once.
 * - Values, not formats: a number stays a number (`12500`, not
 *   «12 500,00 ₸»), a date (a number in a date format) becomes an ISO date,
 *   a formula gives its cached value, a boolean is `TRUE`/`FALSE`, an error
 *   (`#N/A`) is empty.
 * - Merged cells: the value of a range spanning several rows is put into
 *   every row of it (a brand merged over its goods belongs to each of them);
 *   one spanning columns of one row keeps the value in its first cell only
 *   (a title over the table is one cell, not six). At most `MAX_MERGES`
 *   ranges a sheet; applying them costs the columns of a row, not the
 *   ranges.
 */

/** The most a sheet may unpack into (and the budget of the file, if smaller). */
const SHEET_CEILING = 512 * 1024 * 1024;
/** The most the list of sheets, the styles, the shared strings may unpack into. */
const SMALL_CEILING = 64 * 1024 * 1024;
/** Merged ranges a sheet may list: twice the rows a price list may have. */
export const MAX_MERGES = 100_000;
/** Shared strings a workbook may have: twenty for each row a price list may have. */
export const MAX_SHARED_STRINGS = 1_000_000;
/** Text kept of one cell while it is read (a cell keeps `MAX_CELL_LENGTH` after trimming). */
const COLLECT_LIMIT = MAX_CELL_LENGTH * 4;

/** Awaited between pieces of a file: gives the event loop a turn, may stop the reading. */
export type Between = () => Promise<void>;

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

/** Text collected up to `COLLECT_LIMIT`: a cell of megabytes keeps only its start. */
class Collected {
  private readonly parts: string[] = [];
  private length = 0;

  push(text: string): void {
    if (this.length >= COLLECT_LIMIT) return;
    const piece =
      text.length > COLLECT_LIMIT - this.length ? text.slice(0, COLLECT_LIMIT - this.length) : text;
    this.parts.push(piece);
    this.length += piece.length;
  }

  text(): string {
    return this.parts.join("");
  }
}

/** A problem of the XML itself, as sax reports it. */
class XmlError extends Error {}

interface XmlHandlers {
  open?: (name: string, attributes: Record<string, string>) => void;
  text?: (text: string) => void;
  close?: (name: string) => void;
}

/**
 * Parses one part of the archive as a stream, calling `open`/`text`/`close`
 * for its nodes. A handler may throw to stop the reading: a `PriceFileError`
 * it throws passes through as it is; any other problem of the XML is a
 * broken file.
 */
async function parsePart(
  archive: ZipArchive,
  entry: ZipEntry,
  ceiling: number,
  handlers: XmlHandlers,
  between: Between,
): Promise<void> {
  const parser = sax.parser(true, { trim: false, normalize: false, position: false });
  // sax only remembers an error until the next write; it is thrown at once instead.
  parser.onerror = (error) => {
    throw new XmlError(error.message);
  };
  parser.onopentag = (node) => {
    handlers.open?.(localName(node.name), node.attributes as Record<string, string>);
  };
  parser.ontext = (text) => handlers.text?.(text);
  parser.oncdata = (text) => handlers.text?.(text);
  parser.onclosetag = (name) => handlers.close?.(localName(name));
  const decoder = new TextDecoder("utf-8");
  const write = (text: string, close: boolean) => {
    try {
      parser.write(text);
      if (close) parser.close();
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
      throw new PriceFileError("broken", `The Excel file is damaged: ${entry.name} can't be read`);
    }
  };
  await archive.stream(
    entry,
    ceiling,
    (chunk) => write(decoder.decode(chunk, { stream: true }), false),
    between,
  );
  write(decoder.decode(), true);
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

async function relationships(archive: ZipArchive, part: string, between: Between) {
  const folder = part.split("/").slice(0, -1).join("/");
  const file = part.split("/").at(-1)!;
  const path = `${folder ? `${folder}/` : ""}_rels/${file}.rels`;
  const entry = archive.entries.get(path);
  const map = new Map<string, { target: string; type: string }>();
  if (!entry) return map;
  await parsePart(
    archive,
    entry,
    SMALL_CEILING,
    {
      open(name, attributes) {
        if (name === "Relationship" && attributes.Id && attributes.Target) {
          map.set(attributes.Id, {
            target: resolvePath(part, attributes.Target),
            type: attributes.Type ?? "",
          });
        }
      },
    },
    between,
  );
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

async function readStyles(archive: ZipArchive, path: string | undefined, between: Between) {
  const dates = new Set<number>();
  const entry = path ? archive.entries.get(path) : undefined;
  if (!entry) return dates;
  const custom = new Map<number, string>();
  let inCellXfs = false;
  let index = 0;
  const formats: number[] = [];
  await parsePart(
    archive,
    entry,
    SMALL_CEILING,
    {
      open(name, attributes) {
        if (name === "numFmt" && attributes.numFmtId) {
          custom.set(Number(attributes.numFmtId), (attributes.formatCode ?? "").slice(0, 256));
        } else if (name === "cellXfs") {
          inCellXfs = true;
        } else if (name === "xf" && inCellXfs) {
          formats[index++] = Number(attributes.numFmtId ?? 0);
        }
      },
      close(name) {
        if (name === "cellXfs") inCellXfs = false;
      },
    },
    between,
  );
  formats.forEach((format, style) => {
    const code = custom.get(format);
    if (code !== undefined ? isDateFormat(code) : BUILT_IN_DATES.has(format)) dates.add(style);
  });
  return dates;
}

async function readSharedStrings(archive: ZipArchive, path: string | undefined, between: Between) {
  const strings: string[] = [];
  const entry = path ? archive.entries.get(path) : undefined;
  if (!entry) return strings;
  let current: Collected | null = null;
  let inText = false;
  let phonetic = 0;
  await parsePart(
    archive,
    entry,
    SMALL_CEILING,
    {
      open(name) {
        if (name === "si") current = new Collected();
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
          if (strings.length >= MAX_SHARED_STRINGS) {
            throw new PriceFileError("broken", "The workbook has more strings than a price list");
          }
          strings.push(current.text());
          current = null;
        }
      },
    },
    between,
  );
  return strings;
}

/** What the names of an archive's entries say it is: a workbook, or what instead. */
function notAWorkbook(entries: Map<string, ZipEntry>): PriceFileError | null {
  if (entries.has("word/document.xml")) {
    return new PriceFileError("not_a_table", "This archive is not an Excel workbook", {
      detected: "docx",
    });
  }
  if (entries.has("content.xml")) {
    return new PriceFileError("not_a_table", "This archive is not an Excel workbook", {
      detected: "ods",
    });
  }
  for (const name of entries.keys()) {
    if (name === "workbook.xml" || name.endsWith("/workbook.xml")) return null;
  }
  return new PriceFileError("not_a_table", "This archive is not an Excel workbook", {
    detected: "zip",
  });
}

async function readBook(archive: ZipArchive, between: Between): Promise<Book> {
  const entries = archive.entries;
  const root = await relationships(archive, "", between);
  const office = [...root.values()].find((rel) => rel.type.endsWith("/officeDocument"));
  const workbookPath = office?.target ?? "xl/workbook.xml";
  const workbook = entries.get(workbookPath);
  if (!workbook) {
    // A ZIP that is not a workbook: a .docx, an .ods, an archive of anything.
    throw (
      notAWorkbook(entries) ??
      new PriceFileError("not_a_table", "This archive is not an Excel workbook", {
        detected: "zip",
      })
    );
  }
  const rels = await relationships(archive, workbookPath, between);
  const listed: { name: string; id: string; hidden: boolean }[] = [];
  let date1904 = false;
  await parsePart(
    archive,
    workbook,
    SMALL_CEILING,
    {
      open(name, attributes) {
        if (name === "sheet") {
          const id =
            attributes["r:id"] ??
            Object.entries(attributes).find(([key]) => key.endsWith(":id"))?.[1];
          if (id) {
            listed.push({
              name: (attributes.name ?? "").slice(0, 255),
              id,
              hidden: attributes.state === "hidden" || attributes.state === "veryHidden",
            });
          }
        } else if (name === "workbookPr") {
          date1904 = attributes.date1904 === "1" || attributes.date1904 === "true";
        }
      },
    },
    between,
  );
  const ofType = (suffix: string) =>
    [...rels.values()].find((rel) => rel.type.endsWith(suffix))?.target;
  const seen = new Set<string>();
  const sheets = listed
    .filter((sheet) => !sheet.hidden)
    .map((sheet) => ({ name: sheet.name, path: rels.get(sheet.id)?.target ?? "" }))
    // A sheet listed twice is still one sheet: it is unpacked once at most.
    .filter((sheet) => entries.has(sheet.path) && !seen.has(sheet.path) && seen.add(sheet.path));
  return {
    sheets,
    sharedStrings: await readSharedStrings(archive, ofType("/sharedStrings"), between),
    dateStyles: await readStyles(archive, ofType("/styles"), between),
    date1904,
  };
}

/** «B12» → column 1 (0-based); «AA3» → 26. */
export function columnIndex(reference: string): number {
  let column = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
    // Columns past the ones read are all the same: «not read».
    if (column > MAX_COLUMNS * 26) return MAX_COLUMNS * 26;
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
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16);
}

interface Merge {
  firstRow: number;
  lastRow: number;
  column: number;
}

/** A range spanning rows within the columns read; `null` — nothing to fill in. */
function parseMerge(reference: string): Merge | null {
  const [from, to] = reference.split(":");
  if (!from || !to) return null;
  const firstRow = rowOf(from);
  const lastRow = rowOf(to);
  const column = columnIndex(from);
  if (lastRow <= firstRow || firstRow < 1 || column < 0 || column >= MAX_COLUMNS) return null;
  return { firstRow, lastRow, column };
}

/**
 * The ranges spanning rows, by the row they start at: one per column of a
 * row (overlapping ranges are not what Excel writes; the longest wins).
 */
class Merges {
  readonly byFirstRow = new Map<number, Map<number, number>>();
  count = 0;

  add(reference: string): void {
    if (++this.count > MAX_MERGES) {
      throw new PriceFileError(
        "broken",
        `The sheet merges more than ${String(MAX_MERGES)} ranges; a price list has far fewer`,
      );
    }
    const merge = parseMerge(reference);
    if (!merge) return;
    let row = this.byFirstRow.get(merge.firstRow);
    if (!row) {
      row = new Map();
      this.byFirstRow.set(merge.firstRow, row);
    }
    if ((row.get(merge.column) ?? 0) < merge.lastRow) row.set(merge.column, merge.lastRow);
  }
}

/**
 * Puts the value of every open range into the rows it spans. A row costs
 * its columns (at most `MAX_COLUMNS`), never the number of ranges.
 */
class MergeFiller {
  private readonly open = new Map<number, { lastRow: number; value: PriceCell }>();

  constructor(private readonly merges: Merges) {}

  fill(row: FileRow): void {
    for (const [column, range] of this.open) {
      if (range.lastRow < row.rowNo) {
        this.open.delete(column);
      } else if ((row.cells[column] ?? null) === null) {
        row.cells[column] = range.value;
      }
    }
    const starting = this.merges.byFirstRow.get(row.rowNo);
    if (!starting) return;
    for (const [column, lastRow] of starting) {
      const value = row.cells[column] ?? null;
      if (value !== null) this.open.set(column, { lastRow, value });
    }
  }
}

/** Stops the walk of a sheet without it being a problem of the file. */
class WalkStopped extends Error {}

/** Walks a sheet: rows to `onRow`, merged ranges to `merges`. */
async function walkSheet(
  archive: ZipArchive,
  entry: ZipEntry,
  book: Book,
  onRow: (row: FileRow) => void,
  merges: Merges | null,
  between: Between,
): Promise<void> {
  let rowNo = 0;
  let cells: PriceCell[] = [];
  let column = -1;
  let type = "n";
  let style = 0;
  let value: Collected | null = null;
  let inline: Collected | null = null;
  let collect: Collected | null = null;
  let phonetic = 0;
  let inSheetData = false;

  await parsePart(
    archive,
    entry,
    SHEET_CEILING,
    {
      open(name, attributes) {
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
            value = new Collected();
            collect = value;
            break;
          case "is":
            inline = new Collected();
            break;
          case "rPh":
            phonetic++;
            break;
          case "t":
            if (inline && phonetic === 0) collect = inline;
            break;
          case "mergeCell":
            if (merges && attributes.ref) merges.add(attributes.ref);
            break;
        }
      },
      text(text) {
        collect?.push(text);
      },
      close(name) {
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
                value?.text() ?? null,
                inline?.text() ?? null,
                book,
              );
              if (cell !== null) cells[column] = cell;
            }
            break;
          case "row":
            if (inSheetData && cells.some((cell) => cell !== null)) {
              onRow({ rowNo, cells: Array.from(cells, (cell) => cell ?? null) });
            }
            break;
          case "sheetData":
            inSheetData = false;
            break;
        }
      },
    },
    between,
  );
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

function tooManyRows(rows: number, maxRows: number): PriceFileError {
  return new PriceFileError(
    "too_many_rows",
    `The sheet has more than ${String(maxRows)} rows (${String(rows)} read so far); at most ${String(maxRows)} are taken at once`,
    { limit: maxRows },
  );
}

/**
 * Reads the rows of an `.xlsx` into `sink`. Returns the sheet's name. A
 * workbook with no sheet like a table is `empty`; more non-empty rows than
 * `maxRows` on the chosen sheet is `too_many_rows` — found by the first
 * pass (which stops at the first row past the limit), before anything is
 * written. Everything unpacked, on every pass, spends from the budget of
 * the file (`unpackBudget`).
 */
export async function readXlsx(
  bytes: Buffer,
  maxRows: number,
  sink: RowSink,
  between: Between,
): Promise<{ sheetName: string }> {
  const archive = new ZipArchive(bytes);
  const book = await readBook(archive, between);
  for (const sheet of book.sheets) {
    const entry = archive.entries.get(sheet.path)!;
    // The first pass: is it a table, how many rows, which ranges are merged
    // (they are listed after the rows, so a second pass fills them in).
    const merges = new Merges();
    let rows = 0;
    let table = false;
    try {
      await walkSheet(
        archive,
        entry,
        book,
        (row) => {
          rows++;
          if (!table && tableLike(row)) table = true;
          if (rows > maxRows) throw new WalkStopped();
        },
        merges,
        between,
      );
    } catch (error) {
      if (!(error instanceof WalkStopped)) throw error;
      if (table) throw tooManyRows(rows, maxRows);
      // More rows than a price list and none of them like a table: not this sheet.
      continue;
    }
    if (!table) continue;
    const filler = new MergeFiller(merges);
    await walkSheet(
      archive,
      entry,
      book,
      (row) => {
        filler.fill(row);
        sink.row(row);
      },
      null,
      async () => {
        await between();
        await sink.flush();
      },
    );
    return { sheetName: sheet.name };
  }
  throw new PriceFileError("empty", "The workbook has no sheet with a table");
}

/**
 * The check of an upload (TASK-046.A requirement 1): only the directory of
 * the archive is read — never an entry unpacked — so it costs the same
 * little for any file. The directory opens and isn't too long, no entry is
 * encrypted or claims a size its compressed bytes contradict
 * (`entryProblem`), and the names say it is a workbook (not a
 * `.docx`/`.ods`).
 * Everything else — the parts themselves, the sheets, the rows — is the
 * worker's.
 */
export function checkXlsx(bytes: Buffer): void {
  const entries = zipEntries(bytes);
  const budget = unpackBudget(bytes.length);
  for (const entry of entries.values()) {
    if (entry.encrypted) {
      throw new PriceFileError("encrypted", "The Excel file is protected by a password");
    }
    const problem = entryProblem(entry, budget);
    if (problem) throw problem;
  }
  const problem = notAWorkbook(entries);
  if (problem) throw problem;
}
