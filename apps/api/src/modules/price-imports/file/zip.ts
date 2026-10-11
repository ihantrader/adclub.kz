import { Inflate } from "fflate";
import { PriceFileError } from "../price-import-errors";

/**
 * The ZIP container of an `.xlsx` (TASK-046, TASK-046.A; ARCHITECTURE 4.66):
 * the central directory is read by hand, so an entry is found by its name
 * and inflated alone — as a stream, never whole in memory.
 *
 * A file of 20 MB can claim one size and unpack into another. Nothing here
 * trusts the claim: every entry is inflated piece by piece, and the moment
 * it gives more than it declared, or more than is left of the budget of
 * the whole file, the inflating stops and the file is broken. The budget
 * (`unpackBudget`) is shared by every entry and every pass over a sheet.
 * Encrypted entries, other compression methods and ZIP64 are not what
 * Excel writes — they are refused as broken.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

/** More entries than a workbook has (sheets, styles, pictures): a broken file. */
export const MAX_ZIP_ENTRIES = 2000;

/** Unpacked bytes a file may give per byte of it, over all its entries and passes. */
export const UNPACK_RATIO = 200;
/** The budget of a small file: its XML is mostly tags, compressed little. */
export const UNPACK_FLOOR = 32 * 1024 * 1024;
/** The budget of any file, however large. */
export const UNPACK_CEILING = 512 * 1024 * 1024;

/** How many unpacked bytes reading a file of `fileBytes` may produce in all. */
export function unpackBudget(fileBytes: number): number {
  return Math.min(UNPACK_CEILING, Math.max(UNPACK_FLOOR, UNPACK_RATIO * fileBytes));
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function broken(message: string): PriceFileError {
  return new PriceFileError("broken", message);
}

/**
 * The entries of the archive by name — only its directory is read, nothing
 * is unpacked, so this is cheap for any file. A damaged directory, or more
 * than `MAX_ZIP_ENTRIES` entries, is a broken file.
 */
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
  if (count > MAX_ZIP_ENTRIES) {
    throw broken(`The archive has ${String(count)} entries; a workbook has far fewer`);
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
    if (at + 46 + nameLength > bytes.length) {
      throw broken("The ZIP directory of the Excel file is damaged");
    }
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

/**
 * What the directory alone says is wrong with an entry — nothing unpacked
 * (TASK-046.A requirement 1):
 * - deflate never makes data larger than about 1/256 more than it was, so
 *   an entry whose compressed bytes far outweigh its declared size claims
 *   a size it doesn't have (the acceptance's file: «100 bytes» in 20 MB);
 * - a part of the workbook (XML, relationships) declared larger than the
 *   whole budget of the file could never be read.
 */
export function entryProblem(entry: ZipEntry, budget: number): PriceFileError | null {
  const plausible =
    entry.method === 0
      ? entry.compressedSize === entry.size
      : entry.compressedSize <= entry.size + Math.ceil(entry.size / 256) + 1024;
  if (!plausible) {
    return broken(`The entry ${entry.name} says it is smaller than its compressed bytes`);
  }
  if (/\.(xml|rels)$/i.test(entry.name) && entry.size > budget) {
    return broken(`The entry ${entry.name} is larger than a price list can be`);
  }
  return null;
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

/**
 * How many compressed bytes go into the inflater at once. Deflate can give
 * about a thousand bytes per byte, so a piece this small can't unpack into
 * more than about a megabyte before the count below sees it (and the XML
 * reader never gets more than that at once).
 */
const CHUNK = 1024;
/** Unpacked bytes handed on between two turns of the event loop. */
const TURN_BYTES = 256 * 1024;

/**
 * An opened archive with the budget of unpacked bytes it has left: every
 * entry inflated through it, on every pass, spends from the same budget.
 */
export class ZipArchive {
  readonly entries: Map<string, ZipEntry>;
  private left: number;

  constructor(
    private readonly bytes: Buffer,
    budget = unpackBudget(bytes.length),
  ) {
    this.entries = zipEntries(bytes);
    this.left = budget;
  }

  /** What is left of the budget. */
  get remaining(): number {
    return this.left;
  }

  /**
   * Inflates an entry piece by piece: `onChunk` gets the output as it comes,
   * synchronously; between pieces of input `between` is awaited (it yields
   * to the event loop and may stop the reading). The entry may give exactly
   * the size it declares, no more and no less, and never more than is left
   * of the budget or `ceiling`; the inflating stops at the first byte past.
   */
  async stream(
    entry: ZipEntry,
    ceiling: number,
    onChunk: (chunk: Uint8Array) => void,
    between: () => Promise<void>,
  ): Promise<void> {
    if (entry.size > ceiling || entry.size > this.left) {
      throw broken(`The entry ${entry.name} is larger than a price list can be`);
    }
    const problem = entryProblem(entry, Number.POSITIVE_INFINITY);
    if (problem) throw problem;
    const data = dataOf(this.bytes, entry);
    const limit = entry.size;
    let produced = 0;
    const take = (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      produced += chunk.length;
      this.left -= chunk.length;
      if (produced > limit) throw broken(`The entry ${entry.name} unpacks into more than it says`);
      onChunk(chunk);
    };
    if (entry.method === 0) {
      if (data.length !== limit) throw broken(`The entry ${entry.name} is damaged`);
      for (let at = 0; at < data.length; at += 64 * 1024) {
        take(data.subarray(at, at + 64 * 1024));
        await between();
      }
      return;
    }
    let failure: unknown = null;
    let ended = false;
    const inflate = new Inflate((chunk, final) => {
      if (failure) return;
      try {
        take(chunk);
      } catch (error) {
        failure = error;
        // The inflater can't be told to stop: its output is dropped from here on.
      }
      if (final) ended = true;
    });
    let turn = 0;
    for (let at = 0; at < data.length; at += CHUNK) {
      try {
        inflate.push(data.subarray(at, at + CHUNK), at + CHUNK >= data.length);
      } catch {
        if (failure) throw failure;
        throw broken(`The entry ${entry.name} of the Excel file is damaged`);
      }
      if (failure) throw failure;
      // The event loop gets a turn every 256 KiB parsed or 64 KiB of input.
      if (produced - turn >= TURN_BYTES || (at / CHUNK) % 64 === 63) {
        turn = produced;
        await between();
      }
    }
    if (failure) throw failure;
    if (!ended || produced !== limit) throw broken(`The entry ${entry.name} is damaged`);
    await between();
  }

  /** A small entry (the workbook, its relationships) whole; at most `ceiling` bytes. */
  async read(entry: ZipEntry, ceiling: number, between: () => Promise<void>): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    await this.stream(entry, ceiling, (chunk) => chunks.push(chunk.slice()), between);
    return Buffer.concat(chunks);
  }
}
