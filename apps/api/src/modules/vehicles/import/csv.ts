import {
  vehicleImportColumns,
  vehicleImportRequiredColumns,
  type VehicleImportColumn,
} from "@adclub/contracts";
import { importFileInvalid } from "../vehicle-errors";

/**
 * Reading an import file (TASK-014 requirement 3; ARCHITECTURE 4.24).
 *
 * What the file is decides its content, not its name or declared type
 * (as photos, 4.22 I200): a spreadsheet saved as `.xlsx`, a PDF or a
 * picture is recognised by its first bytes and refused with its name; a
 * file with NUL bytes is binary. The text must be UTF-8 (a byte order
 * mark is allowed and dropped); UTF-16 is recognised and refused with a
 * hint. The separator is found in the header — comma, semicolon (what
 * Excel writes in Russian locales) or tab. Fields follow RFC 4180: quotes
 * around a field, a doubled quote inside it, line breaks inside quotes.
 */

export type ImportDelimiter = "," | ";" | "\t";

export interface ImportFileRow {
  /** As a spreadsheet numbers it: the header is row 1. */
  rowNumber: number;
  /** Cells by column; `null` — the row has more or fewer cells than the header. */
  values: Partial<Record<VehicleImportColumn, string>> | null;
  /** The cells as read, for a row that doesn't fit the header. */
  cells: string[];
}

export interface ImportFile {
  delimiter: ImportDelimiter;
  columns: VehicleImportColumn[];
  rows: ImportFileRow[];
}

const SIGNATURES: readonly { detected: string; bytes: readonly number[] }[] = [
  // A ZIP container: .xlsx, .ods, .docx.
  { detected: "xlsx", bytes: [0x50, 0x4b, 0x03, 0x04] },
  // The OLE compound file of the old .xls.
  { detected: "xls", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { detected: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { detected: "image", bytes: [0xff, 0xd8, 0xff] },
  { detected: "image", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { detected: "image", bytes: [0x47, 0x49, 0x46, 0x38] },
];

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** The text of the file, or a refusal saying what it is instead. */
export function decodeImportFile(bytes: Buffer): string {
  if (bytes.length === 0) {
    throw importFileInvalid("empty", "The file is empty");
  }
  for (const signature of SIGNATURES) {
    if (startsWith(bytes, signature.bytes)) {
      throw importFileInvalid(
        "unsupported_format",
        `This is not a CSV table (${signature.detected}); save the sheet as CSV (UTF-8)`,
        { detected: signature.detected },
      );
    }
  }
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    throw importFileInvalid("encoding", "The file is in UTF-16; save it as CSV (UTF-8)", {
      detected: "utf-16",
    });
  }
  if (bytes.subarray(0, 64 * 1024).includes(0)) {
    throw importFileInvalid("unsupported_format", "This is a binary file, not a CSV table", {
      detected: "binary",
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw importFileInvalid(
      "encoding",
      "The file is not in UTF-8 (perhaps Windows-1251); save it as CSV (UTF-8)",
      { detected: "unknown" },
    );
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.trim() === "") {
    throw importFileInvalid("empty", "The file is empty");
  }
  return text;
}

/** The separator the header uses the most, outside quotes. */
function detectDelimiter(text: string): ImportDelimiter {
  const counts: Record<ImportDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      break;
    } else if (!quoted && character in counts) {
      counts[character as ImportDelimiter] += 1;
    }
  }
  const [best] = (Object.entries(counts) as [ImportDelimiter, number][]).sort(
    (a, b) => b[1] - a[1],
  );
  return best![1] > 0 ? best![0] : ",";
}

interface Record_ {
  cells: string[];
}

/** Splits RFC 4180 text into records. */
function records(text: string, delimiter: ImportDelimiter): Record_[] {
  const result: Record_[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let quoteLine = 1;
  const endRecord = () => {
    cells.push(cell);
    result.push({ cells });
    cells = [];
    cell = "";
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        if (character === "\n") {
          line++;
        }
        cell += character;
      }
      continue;
    }
    if (character === '"' && cell === "") {
      quoted = true;
      quoteLine = line;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") {
        index++;
      }
      endRecord();
      line++;
    } else {
      cell += character;
    }
  }
  if (quoted) {
    throw importFileInvalid("malformed", `A quote opened on line ${quoteLine} is never closed`, {
      line: quoteLine,
    });
  }
  if (cell !== "" || cells.length > 0) {
    endRecord();
  }
  return result;
}

const KNOWN = new Set<string>(vehicleImportColumns);

/**
 * The header and rows of an import file. Empty rows (every cell blank)
 * are skipped. File-level problems are refused here with
 * `VEHICLE_IMPORT_FILE_INVALID`; problems of a row are left to the check.
 */
export function readImportFile(bytes: Buffer, maxRows: number): ImportFile {
  const text = decodeImportFile(bytes);
  const delimiter = detectDelimiter(text);
  // A row keeps the number a spreadsheet gives it, blank rows counted.
  const all = records(text, delimiter)
    .map((record, index) => ({ ...record, rowNumber: index + 1 }))
    .filter((record) => record.cells.some((cell) => cell.trim() !== ""));
  const [header, ...body] = all;
  if (!header) {
    throw importFileInvalid("empty", "The file is empty");
  }
  const names = header.cells.map((cell) => cell.trim().toLowerCase());
  const unknown = names.filter((name) => !KNOWN.has(name));
  if (unknown.length > 0) {
    throw importFileInvalid(
      "unknown_columns",
      `Unknown columns: ${unknown.join(", ")} (see the template)`,
      { columns: unknown },
    );
  }
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length > 0) {
    throw importFileInvalid("duplicate_columns", `Repeated columns: ${repeated.join(", ")}`, {
      columns: [...new Set(repeated)],
    });
  }
  const missing = vehicleImportRequiredColumns.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    throw importFileInvalid("missing_columns", `Missing columns: ${missing.join(", ")}`, {
      columns: missing,
    });
  }
  if (body.length === 0) {
    throw importFileInvalid("no_rows", "The file has a header and no rows");
  }
  if (body.length > maxRows) {
    throw importFileInvalid(
      "too_many_rows",
      `The file has ${body.length} rows; at most ${maxRows} are taken at once`,
      { limit: maxRows },
    );
  }
  const columns = names as VehicleImportColumn[];
  return {
    delimiter,
    columns,
    rows: body.map((record) => ({
      rowNumber: record.rowNumber,
      cells: record.cells,
      values:
        record.cells.length === columns.length
          ? Object.fromEntries(columns.map((column, at) => [column, record.cells[at]!.trim()]))
          : null,
    })),
  };
}
