import { constants, deflateRawSync } from "node:zlib";
import { unzipSync } from "fflate";
import { writeXlsx } from "./xlsx-writer";

/**
 * Hostile `.xlsx` files for the tests of TASK-046.A (ARCHITECTURE 4.66):
 * a ZIP written by hand, so an entry can claim any size, and deflate
 * streams of gigabytes built in milliseconds.
 *
 * A deflate stream flushed with `Z_FULL_FLUSH` ends on a byte boundary and
 * refers to nothing before it, so one compressed megabyte of zeros (about a
 * kilobyte) repeated N times is a valid stream of N megabytes — what the
 * acceptance of TASK-046 built by hand: an entry declared as 100 bytes
 * that unpacks into gigabytes.
 */

export interface RawZipEntry {
  name: string;
  /** 0 — stored, 8 — deflated. */
  method: 0 | 8;
  /** The bytes as they lie in the archive (compressed for method 8). */
  data: Uint8Array;
  /** The unpacked size the archive declares — honest or not. */
  size: number;
  /** Sets the «encrypted» flag of the entry. */
  encrypted?: boolean;
}

/** A ZIP of the entries as given: nothing is checked or recomputed (the CRC is zero). */
export function writeRawZip(entries: readonly RawZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const flags = entry.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(
      local,
      name,
      Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.length),
    );
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.size >>> 0, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(entries.length, 0xfffe), 8);
  end.writeUInt16LE(Math.min(entries.length, 0xfffe), 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A self-contained, byte-aligned, non-final piece of a deflate stream. */
function segment(bytes: Uint8Array): Buffer {
  return deflateRawSync(bytes, { level: 9, finishFlush: constants.Z_FULL_FLUSH });
}

const FINAL = deflateRawSync(Buffer.alloc(0));
const MEGABYTE = 1024 * 1024;

/**
 * A deflate stream of `prefix`, then `megabytes` of `fill`, then `suffix`;
 * a megabyte of a repeated byte compresses into about a kilobyte.
 */
export function deflateFill(options: {
  prefix?: string;
  fill: number;
  megabytes: number;
  suffix?: string;
}): { data: Buffer; size: number } {
  const piece = segment(Buffer.alloc(MEGABYTE, options.fill));
  const prefix = Buffer.from(options.prefix ?? "", "utf8");
  const suffix = Buffer.from(options.suffix ?? "", "utf8");
  const parts = [segment(prefix)];
  for (let index = 0; index < options.megabytes; index++) parts.push(piece);
  parts.push(segment(suffix), FINAL);
  return {
    data: Buffer.concat(parts),
    size: prefix.length + options.megabytes * MEGABYTE + suffix.length,
  };
}

/** The entries of a small honest workbook, deflated, with true sizes. */
function workbookEntries(): RawZipEntry[] {
  const parts = unzipSync(
    writeXlsx([
      {
        name: "Прайс",
        rows: [
          ["Артикул", "Наименование", "Цена"],
          ["04465-0K090", "Колодки тормозные", 12500],
        ],
      },
    ]),
  );
  return Object.entries(parts).map(([name, bytes]) => ({
    name,
    method: 8,
    data: deflateRawSync(bytes),
    size: bytes.length,
  }));
}

export const SHARED_STRINGS = "xl/sharedStrings.xml";
export const SHEET = "xl/worksheets/sheet1.xml";

/**
 * A workbook whose `part` unpacks into `megabytes` (about the same number of
 * kilobytes in the file) while the archive says it is `declaredSize`
 * bytes. `fill` 0 — zeros, as the acceptance built it; 0x20 — spaces
 * inside the tags of the part, which an XML reader takes as text.
 */
export function xlsxBomb(options: {
  part: typeof SHARED_STRINGS | typeof SHEET;
  megabytes: number;
  declaredSize?: number;
  fill?: number;
  /**
   * One ordinary deflate stream of the whole part, as zlib writes it (the
   * acceptance's file) instead of repeated pieces: slower to build (the
   * part is compressed whole), so for a few hundred megabytes at most.
   */
  single?: boolean;
}): Buffer {
  const fill = options.fill ?? 0;
  if (options.single) {
    const data = deflateRawSync(Buffer.alloc(options.megabytes * MEGABYTE, fill), { level: 9 });
    return writeRawZip(
      workbookEntries().map((entry) =>
        entry.name === options.part
          ? { ...entry, data, size: options.declaredSize ?? options.megabytes * MEGABYTE }
          : entry,
      ),
    );
  }
  const xml =
    options.part === SHEET
      ? {
          prefix:
            '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
          suffix: "</sheetData></worksheet>",
        }
      : {
          prefix:
            '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
          suffix: "</sst>",
        };
  const bomb = deflateFill({
    ...(fill === 0 ? {} : xml),
    fill,
    megabytes: options.megabytes,
  });
  return writeRawZip(
    workbookEntries().map((entry) =>
      entry.name === options.part
        ? { ...entry, data: bomb.data, size: options.declaredSize ?? bomb.size }
        : entry,
    ),
  );
}

/** A workbook with `count` more entries than it needs (each a few bytes). */
export function xlsxWithEntries(count: number): Buffer {
  const extra: RawZipEntry[] = Array.from({ length: count }, (_, index) => ({
    name: `xl/media/extra${String(index)}.bin`,
    method: 0,
    data: Buffer.from("x"),
    size: 1,
  }));
  return writeRawZip([...workbookEntries(), ...extra]);
}

/**
 * A workbook of `rows` rows whose sheet lists `merges` ranges, each over
 * every row of column A — the shape that makes applying them one by one
 * quadratic.
 */
export function xlsxWithMerges(rows: number, merges: number): Buffer {
  const lines = Array.from({ length: rows }, (_, index) =>
    index === 0 ? ["Бренд", "Артикул", "Цена"] : ["Geely", `A-${String(index)}`, 1000 + index],
  );
  const ranges = Array.from({ length: merges }, () => `A2:A${String(rows)}`);
  return writeXlsx([{ name: "Прайс", rows: lines, merges: ranges }]);
}
