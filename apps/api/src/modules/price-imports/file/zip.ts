import { Inflate, inflateSync } from "fflate";
import { PriceFileError } from "../price-import-errors";

/**
 * The ZIP container of an `.xlsx` (TASK-046; ARCHITECTURE 4.66): the
 * central directory is read by hand, so an entry is found by its name and
 * inflated alone — a sheet as a stream, never whole in memory.
 *
 * A file of 20 MB can unpack into gigabytes (a ZIP bomb): every entry is
 * inflated under a ceiling of its own, and passing it is a broken file,
 * not an exhausted worker. Encrypted entries, other compression methods
 * and ZIP64 are not what Excel writes — they are refused as broken.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function broken(message: string): PriceFileError {
  return new PriceFileError("broken", message);
}

/** The entries of the archive by name; a damaged directory is a broken file. */
export function zipEntries(bytes: Buffer): Map<string, ZipEntry> {
  // The end of central directory record: 22 bytes plus a comment of up to 64 KiB.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw broken("The Excel file is cut short: its ZIP directory is missing");
  const count = bytes.readUInt16LE(end + 10);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw broken("ZIP64 archives are not Excel files");
  }
  const entries = new Map<string, ZipEntry>();
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL) {
      throw broken("The ZIP directory of the Excel file is damaged");
    }
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localHeaderOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    entries.set(name, {
      name,
      method,
      compressedSize,
      size,
      localHeaderOffset,
      encrypted: (flags & 1) === 1,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Where the compressed bytes of an entry are. */
function dataOf(bytes: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== LOCAL) {
    throw broken(`The entry ${entry.name} of the Excel file is damaged`);
  }
  if (entry.encrypted) {
    throw new PriceFileError("encrypted", "The Excel file is protected by a password");
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw broken(`The entry ${entry.name} is compressed in a way Excel doesn't use`);
  }
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
  const finish = start + entry.compressedSize;
  if (finish > bytes.length) throw broken(`The entry ${entry.name} is cut short`);
  return bytes.subarray(start, finish);
}

/** A small entry (the workbook, its styles, shared strings) whole; at most `ceiling` bytes. */
export function readEntry(bytes: Buffer, entry: ZipEntry, ceiling: number): Buffer {
  if (entry.size > ceiling) {
    throw broken(`The entry ${entry.name} is larger than a price list can be`);
  }
  const data = dataOf(bytes, entry);
  if (entry.method === 0) return Buffer.from(data);
  let out: Uint8Array;
  try {
    out = inflateSync(data, { out: new Uint8Array(entry.size) });
  } catch {
    throw broken(`The entry ${entry.name} of the Excel file is damaged`);
  }
  if (out.length !== entry.size) throw broken(`The entry ${entry.name} is damaged`);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/** How many compressed bytes go into the inflater at once. */
const CHUNK = 64 * 1024;

/**
 * Inflates an entry piece by piece: `onChunk` gets the output as it comes,
 * synchronously; between pieces of input `between` is awaited, so the
 * caller writes what it collected before more is unpacked. More than
 * `ceiling` bytes of output is a broken file (a ZIP bomb).
 */
export async function streamEntry(
  bytes: Buffer,
  entry: ZipEntry,
  ceiling: number,
  onChunk: (chunk: Uint8Array) => void,
  between: () => Promise<void>,
): Promise<void> {
  const data = dataOf(bytes, entry);
  let produced = 0;
  const take = (chunk: Uint8Array) => {
    produced += chunk.length;
    if (produced > ceiling) throw broken(`The entry ${entry.name} unpacks into too much`);
    onChunk(chunk);
  };
  if (entry.method === 0) {
    for (let at = 0; at < data.length; at += CHUNK) {
      take(data.subarray(at, at + CHUNK));
      await between();
    }
    return;
  }
  let failure: unknown = null;
  const inflate = new Inflate((chunk) => {
    if (failure) return;
    try {
      take(chunk);
    } catch (error) {
      failure = error;
    }
  });
  for (let at = 0; at < data.length; at += CHUNK) {
    try {
      inflate.push(data.subarray(at, at + CHUNK), at + CHUNK >= data.length);
    } catch {
      throw broken(`The entry ${entry.name} of the Excel file is damaged`);
    }
    if (failure) throw failure;
    await between();
  }
}
