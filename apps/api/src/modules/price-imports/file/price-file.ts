import type { PriceImportFormat } from "@adclub/contracts";
import { PriceFileError } from "../price-import-errors";
import { checkCsv, readCsv } from "./csv";
import type { RowSink } from "./rows";
import { checkXlsx, readXlsx } from "./xlsx";

/**
 * What a price file is, decided by its content, never by its name or
 * declared type (TASK-046 requirement 1; ARCHITECTURE 4.66): a ZIP is an
 * `.xlsx` (if it is a workbook), an OLE compound file is the old `.xls` or
 * a password-protected `.xlsx`, a PDF or a picture is not a table, and any
 * other bytes are read as CSV text.
 */

const SIGNATURES: readonly { detected: string; bytes: readonly number[] }[] = [
  { detected: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { detected: "image", bytes: [0xff, 0xd8, 0xff] },
  { detected: "image", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { detected: "image", bytes: [0x47, 0x49, 0x46, 0x38] },
  { detected: "image", bytes: [0x52, 0x49, 0x46, 0x46] },
  { detected: "archive", bytes: [0x52, 0x61, 0x72, 0x21] },
  { detected: "archive", bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { detected: "archive", bytes: [0x1f, 0x8b] },
];

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** «EncryptedPackage» in UTF-16LE: the stream an Excel file under a password keeps. */
const ENCRYPTED_PACKAGE = Buffer.from("EncryptedPackage", "utf16le");

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/** The kind of a file, or the refusal saying what it is instead. */
export function priceFileFormat(bytes: Buffer): PriceImportFormat {
  if (bytes.length === 0) throw new PriceFileError("empty", "The file is empty");
  if (startsWith(bytes, ZIP)) return "xlsx";
  if (startsWith(bytes, OLE)) {
    if (bytes.includes(ENCRYPTED_PACKAGE)) {
      throw new PriceFileError("encrypted", "The Excel file is protected by a password");
    }
    throw new PriceFileError("old_excel", "This is the old .xls format; save the file as .xlsx", {
      detected: "xls",
    });
  }
  for (const signature of SIGNATURES) {
    if (startsWith(bytes, signature.bytes)) {
      throw new PriceFileError("not_a_table", `This is not a table (${signature.detected})`, {
        detected: signature.detected,
      });
    }
  }
  return "csv";
}

export interface UploadFacts {
  format: PriceImportFormat;
  encoding: string | null;
  delimiter: string | null;
}

/**
 * Everything about a file the upload can answer at once: what it is, that it
 * opens, and — for a CSV, which costs nothing to count — that its rows fit
 * `maxRows`. The rows of an `.xlsx` are counted by the worker.
 */
export function checkPriceFile(bytes: Buffer, maxRows: number): UploadFacts {
  const format = priceFileFormat(bytes);
  if (format === "xlsx") {
    checkXlsx(bytes);
    return { format, encoding: null, delimiter: null };
  }
  const facts = checkCsv(bytes, maxRows);
  return { format, encoding: facts.encoding, delimiter: facts.delimiter };
}

export interface ReadFacts {
  sheetName: string | null;
  encoding: string | null;
  delimiter: string | null;
}

/** Reads the rows of a file of a known format into `sink`. */
export async function readPriceFile(
  bytes: Buffer,
  format: PriceImportFormat,
  maxRows: number,
  sink: RowSink,
): Promise<ReadFacts> {
  if (format === "xlsx") {
    const { sheetName } = await readXlsx(bytes, maxRows, sink);
    await sink.flush();
    return { sheetName, encoding: null, delimiter: null };
  }
  const facts = await readCsv(bytes, maxRows, sink);
  return { sheetName: null, encoding: facts.encoding, delimiter: facts.delimiter };
}
