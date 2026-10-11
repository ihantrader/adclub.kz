import type { PriceCell } from "@adclub/domain";
import { PriceFileError } from "../price-import-errors";

import { MAX_CELL_LENGTH, MAX_COLUMNS, tableLike, type FileRow, type RowSink } from "./rows";

/**
 * Reading a CSV price list (TASK-046 requirement 2; ARCHITECTURE 4.66).
 *
 * - The encoding: a byte order mark decides (UTF-8, UTF-16); otherwise
 *   UTF-8 if the bytes are valid UTF-8, else Windows-1251 — what Excel and
 *   1C write in Russian Windows — if what it gives reads as Cyrillic text.
 *   Anything else is `encoding`: the file is not guessed into gibberish.
 * - The separator: of «;», «,» and a tab, the one that splits the first
 *   lines into the same number of cells most often (a title of a 1C export
 *   above the table has none of them, or a comma inside an address).
 * - Fields follow RFC 4180: quotes around a field, a doubled quote inside
 *   it, line breaks inside quotes. A row is numbered as the record of the
 *   file it is (the first line is 1, empty ones counted).
 */

export type CsvDelimiter = ";" | "," | "\t";

/** Text kept of one cell while it is read (a cell keeps `MAX_CELL_LENGTH` after trimming). */
const CELL_KEEP = MAX_CELL_LENGTH * 4;

export interface DecodedCsv {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1251";
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Letters a Russian or Kazakh text in Windows-1251 is made of, beyond ASCII. */
const CYRILLIC_1251 = /[\u0400-\u04ff«»№–—“”„‘’…•°±§©®™\u00a0]/u;

/**
 * Decodes the bytes of a CSV, or refuses with what they are instead.
 * `partial` — the bytes are the start of a file: a character cut at their
 * end is not a fault of the encoding.
 */
export function decodeCsv(bytes: Buffer, partial = false): DecodedCsv {
  const stream = { stream: partial };
  const utf8 = (part: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(part, stream);
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return { text: utf8(bytes.subarray(3)), encoding: "utf-8" };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2), stream),
      encoding: "utf-16le",
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2), stream),
      encoding: "utf-16be",
    };
  }
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) {
    // UTF-16 without a mark: every other byte of ASCII text is zero.
    let oddZeros = 0;
    for (let at = 1; at < head.length; at += 2) if (head[at] === 0) oddZeros++;
    if (oddZeros > head.length / 2 / 3) {
      return { text: new TextDecoder("utf-16le").decode(bytes, stream), encoding: "utf-16le" };
    }
    throw new PriceFileError("not_a_table", "This is a binary file, not a table", {
      detected: "binary",
    });
  }
  try {
    return { text: utf8(bytes), encoding: "utf-8" };
  } catch {
    // Not UTF-8: Windows-1251, if that gives Cyrillic text.
  }
  let text: string;
  try {
    text = new TextDecoder("windows-1251", { fatal: true }).decode(bytes);
  } catch {
    throw encodingError();
  }
  let other = 0;
  let cyrillic = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 0x80) continue;
    if (CYRILLIC_1251.test(character)) cyrillic++;
    else other++;
  }
  if (cyrillic === 0 || other > cyrillic * 0.1) throw encodingError();
  return { text, encoding: "windows-1251" };
}

function encodingError(): PriceFileError {
  return new PriceFileError(
    "encoding",
    "The encoding of the CSV is neither UTF-8 nor Windows-1251; save it as .xlsx or CSV (UTF-8)",
  );
}

/** What a text that is not a table looks like at its start. */
export function notTableText(text: string): string | null {
  const start = text.slice(0, 2048).trimStart().toLowerCase();
  if (start.startsWith("{\\rtf")) return "rtf";
  if (start.startsWith("<?xml") && start.includes("urn:schemas-microsoft-com:office:spreadsheet")) {
    return "xml_spreadsheet";
  }
  if (
    start.startsWith("<!doctype html") ||
    start.startsWith("<html") ||
    /<table[\s>]/.test(start)
  ) {
    return "html";
  }
  if (start.startsWith("<?xml") || start.startsWith("<")) return "xml";
  return null;
}

/** The separator that splits the first lines most consistently. */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = text.split(/\r\n|\n|\r/, 50).filter((line) => line.trim() !== "");
  let best: { delimiter: CsvDelimiter; score: number } = { delimiter: ";", score: 0 };
  for (const delimiter of [";", "\t", ","] as const) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter)).filter((n) => n > 0);
    if (counts.length === 0) continue;
    const frequency = new Map<number, number>();
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    const score = Math.max(...frequency.values());
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === delimiter) count++;
  }
  return count;
}

function cellOf(value: string): PriceCell {
  const trimmed = value.trim().slice(0, MAX_CELL_LENGTH);
  return trimmed === "" ? null : trimmed;
}

/**
 * The records of a CSV text, empty ones skipped; numbers count every record.
 * An opening quote never closed is a broken file (with its line).
 */
export function* csvRows(text: string, delimiter: CsvDelimiter): Generator<FileRow> {
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let recordNo = 1;
  let line = 1;
  let quoteLine = 1;
  // A line of a million separators, a cell of megabytes: only what is kept is held.
  const push = () => {
    if (cells.length < MAX_COLUMNS) cells.push(cell);
  };
  const record = (): FileRow | null => {
    push();
    const values = cells.map(cellOf);
    cells = [];
    cell = "";
    const rowNo = recordNo++;
    return values.some((value) => value !== null) ? { rowNo, cells: values } : null;
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          if (cell.length < CELL_KEEP) cell += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        if (character === "\n") line++;
        if (cell.length < CELL_KEEP) cell += character;
      }
      continue;
    }
    if (character === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
      quoteLine = line;
    } else if (character === delimiter) {
      push();
      cell = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      line++;
      const row = record();
      if (row) yield row;
    } else if (cell.length < CELL_KEEP) {
      cell += character;
    }
  }
  if (quoted) {
    throw new PriceFileError(
      "broken",
      `A quote opened on line ${String(quoteLine)} is never closed`,
      {
        line: quoteLine,
      },
    );
  }
  if (cell !== "" || cells.length > 0) {
    const row = record();
    if (row) yield row;
  }
}

export interface CsvFacts {
  encoding: DecodedCsv["encoding"];
  delimiter: CsvDelimiter;
}

/** What the start of a text says before its rows are read: what it is, how it splits. */
function textFacts(text: string): CsvDelimiter {
  if (text.trim() === "") throw new PriceFileError("empty", "The file is empty");
  const other = notTableText(text);
  if (other) {
    throw new PriceFileError("not_a_table", "This is not a table", { detected: other });
  }
  return detectDelimiter(text);
}

function notATable(): PriceFileError {
  return new PriceFileError("not_a_table", "The text has no columns: it is not a table", {
    detected: "text",
  });
}

function tooManyRows(maxRows: number): PriceFileError {
  return new PriceFileError(
    "too_many_rows",
    `The file has more than ${String(maxRows)} rows; at most ${String(maxRows)} are taken at once`,
    { limit: maxRows },
  );
}

/** The most of a CSV the upload looks at (TASK-046.A requirement 1). */
export const CSV_HEAD_BYTES = 64 * 1024;

/**
 * The check of an upload (TASK-046.A requirement 1): never more than the
 * first `CSV_HEAD_BYTES` are decoded and read. A file that small is
 * checked whole — it decodes, is a table (a row of two or more filled
 * cells), has no more than `maxRows` non-empty rows and no quote left
 * open — in well under a millisecond. Of a larger one only its start is
 * judged: the encoding and whether the text is a table at all; reading it
 * through is the worker's (`readCsv`), with the same reasons.
 */
export function checkCsv(bytes: Buffer, maxRows: number): CsvFacts {
  const whole = bytes.length <= CSV_HEAD_BYTES;
  const { text, encoding } = decodeCsv(whole ? bytes : bytes.subarray(0, CSV_HEAD_BYTES), !whole);
  const delimiter = textFacts(text);
  if (!whole) return { encoding, delimiter };
  let rows = 0;
  let table = false;
  for (const row of csvRows(text, delimiter)) {
    rows++;
    if (!table && tableLike(row)) table = true;
  }
  if (!table) throw notATable();
  if (rows > maxRows) throw tooManyRows(maxRows);
  return { encoding, delimiter };
}

/** How many rows go between two turns of the event loop (and flushes of the sink). */
const ROWS_PER_TURN = 1000;

/**
 * Reads the rows of a CSV into `sink`: the whole file decoded, then a first
 * pass — is it a table, are there too many rows (it stops at the first row
 * past the limit) — and a second one writing the rows. `between` is
 * awaited every thousand rows: the event loop gets its turn.
 */
export async function readCsv(
  bytes: Buffer,
  maxRows: number,
  sink: RowSink,
  between: () => Promise<void>,
): Promise<CsvFacts> {
  const { text, encoding } = decodeCsv(bytes);
  const delimiter = textFacts(text);
  let rows = 0;
  let table = false;
  for (const row of csvRows(text, delimiter)) {
    rows++;
    if (!table && tableLike(row)) table = true;
    if (rows > maxRows) throw tooManyRows(maxRows);
    if (rows % ROWS_PER_TURN === 0) await between();
  }
  if (!table) throw notATable();
  let pending = 0;
  for (const row of csvRows(text, delimiter)) {
    sink.row(row);
    if (++pending >= ROWS_PER_TURN) {
      pending = 0;
      await between();
      await sink.flush();
    }
  }
  await sink.flush();
  return { encoding, delimiter };
}
