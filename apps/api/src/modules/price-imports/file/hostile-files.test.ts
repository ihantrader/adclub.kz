import { describe, expect, it } from "vitest";
import { PriceFileError } from "../price-import-errors";
import {
  SHARED_STRINGS,
  SHEET,
  xlsxBomb,
  xlsxWithEntries,
  xlsxWithMerges,
} from "../testing/zip-bomb";
import { writeXlsx } from "../testing/xlsx-writer";
import { CSV_HEAD_BYTES } from "./csv";
import { checkPriceFile, readPriceFile } from "./price-file";
import type { FileRow } from "./rows";
import { MAX_MERGES } from "./xlsx";
import { MAX_ZIP_ENTRIES, UNPACK_CEILING, UNPACK_FLOOR, unpackBudget } from "./zip";

/**
 * Files made to stop a server (TASK-046.A; ARCHITECTURE 4.66): the upload
 * check never unpacks them, the worker stops unpacking at the first byte
 * past what is allowed, and long readings give the event loop its turns.
 */

const MB = 1024 * 1024;

interface Run {
  rows: FileRow[];
  error: unknown;
  ms: number;
  /** The longest the event loop waited while the file was read. */
  stallMs: number;
  /** How much the memory of the process grew at its most. */
  growthMb: number;
}

async function run(bytes: Buffer, format: "xlsx" | "csv", maxRows = 50_000): Promise<Run> {
  const rows: FileRow[] = [];
  const before = process.memoryUsage().rss;
  let peak = before;
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  const started = performance.now();
  let error: unknown = null;
  try {
    await readPriceFile(bytes, format, maxRows, {
      row: (row) => {
        if (rows.length < 100) rows.push(row);
      },
      flush: () => Promise.resolve(),
    });
  } catch (thrown) {
    error = thrown;
  }
  const ms = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 15));
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  return { rows, error, ms, stallMs, growthMb: (peak - before) / MB };
}

function reasonOf(error: unknown): string | null {
  return error instanceof PriceFileError ? error.reason : null;
}

function timed<T>(check: () => T): { value: T | PriceFileError; ms: number } {
  const started = performance.now();
  try {
    return { value: check(), ms: performance.now() - started };
  } catch (error) {
    if (error instanceof PriceFileError) return { value: error, ms: performance.now() - started };
    throw error;
  }
}

describe("the budget of unpacking", () => {
  it("is a ratio of the file, between a floor and a ceiling", () => {
    expect(unpackBudget(10_000)).toBe(UNPACK_FLOOR);
    expect(unpackBudget(1 * MB)).toBe(200 * MB);
    expect(unpackBudget(20 * MB)).toBe(UNPACK_CEILING);
  });
});

describe("the upload check", () => {
  it("refuses by the directory alone an entry «of 100 bytes» in 20 MB of compressed data (the acceptance's file)", () => {
    const bomb = xlsxBomb({ part: SHARED_STRINGS, megabytes: 19_000, declaredSize: 100 });
    expect(bomb.length).toBeGreaterThan(18 * MB);
    const { value, ms } = timed(() => checkPriceFile(bomb, 50_000));
    expect(reasonOf(value)).toBe("broken");
    expect(ms).toBeLessThan(50);
  });

  it("never unpacks: a workbook that claims a plausible size passes in milliseconds, for the worker to read", () => {
    const bomb = xlsxBomb({ part: SHARED_STRINGS, megabytes: 19_000, declaredSize: 20 * MB });
    const { value, ms } = timed(() => checkPriceFile(bomb, 50_000));
    expect(value).toMatchObject({ format: "xlsx" });
    expect(ms).toBeLessThan(50);
  });

  it("refuses a part declared larger than the budget of the file", () => {
    const bomb = xlsxBomb({ part: SHEET, megabytes: 3_500, fill: 0x20 });
    expect(reasonOf(timed(() => checkPriceFile(bomb, 50_000)).value)).toBe("broken");
  });

  it("refuses an archive of thousands of entries by its directory alone", () => {
    const many = xlsxWithEntries(MAX_ZIP_ENTRIES + 10);
    const { value, ms } = timed(() => checkPriceFile(many, 50_000));
    expect(reasonOf(value)).toBe("broken");
    expect(ms).toBeLessThan(50);
  });

  it("reads no more than the start of a large CSV", () => {
    const lines = ["Артикул;Цена"];
    for (let index = 1; index < 20_000; index++) lines.push(`X${String(index)};100`);
    // Far past the start: a quote never closed, and more rows than allowed.
    const bytes = Buffer.from(`${lines.join("\n")}\n"X0;100\n`);
    expect(bytes.length).toBeGreaterThan(CSV_HEAD_BYTES * 3);
    const { value, ms } = timed(() => checkPriceFile(bytes, 100));
    expect(value).toMatchObject({ format: "csv" });
    expect(ms).toBeLessThan(50);
  });
});

describe("the worker unpacking a hostile workbook", () => {
  it("stops at once when shared strings unpack into more than they declare", async () => {
    const bomb = xlsxBomb({ part: SHARED_STRINGS, megabytes: 19_000, declaredSize: 20 * MB });
    const result = await run(bomb, "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
    expect(result.ms).toBeLessThan(2000);
    expect(result.growthMb).toBeLessThan(200);
  });

  it("stops at once on one ordinary deflate stream declared as 100 bytes (the acceptance's file)", async () => {
    const bomb = xlsxBomb({
      part: SHARED_STRINGS,
      megabytes: 256,
      declaredSize: 100,
      single: true,
    });
    // Refused at the upload by its directory; the worker refuses it the same way.
    expect(reasonOf(timed(() => checkPriceFile(bomb, 50_000)).value)).toBe("broken");
    const result = await run(bomb, "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
    expect(result.ms).toBeLessThan(500);
    expect(result.growthMb).toBeLessThan(100);
  });

  it("stops at once when a sheet unpacks into more than it declares", async () => {
    const bomb = xlsxBomb({ part: SHEET, megabytes: 19_000, declaredSize: 20 * MB, fill: 0x20 });
    const result = await run(bomb, "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
    expect(result.ms).toBeLessThan(2000);
    expect(result.growthMb).toBeLessThan(200);
  });

  it("refuses an entry honestly declared larger than the budget of the file, unpacking nothing", async () => {
    const bomb = xlsxBomb({ part: SHEET, megabytes: 3_500, fill: 0x20 });
    expect(bomb.length).toBeLessThan(5 * MB);
    const result = await run(bomb, "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
    expect(result.ms).toBeLessThan(500);
    expect(result.growthMb).toBeLessThan(100);
  });

  it("spends the same budget on every pass: within it a sheet is read, past it — broken", async () => {
    // 300 MB of spaces in a sheet of a 300 KB file: 60 MB of budget.
    const bomb = xlsxBomb({ part: SHEET, megabytes: 300, fill: 0x20 });
    const result = await run(bomb, "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
    expect(result.growthMb).toBeLessThan(200);
    // A workbook as a price list is never near it.
    const fine = writeXlsx([
      {
        name: "Прайс",
        rows: [
          ["Артикул", "Цена"],
          ["A-1", 100],
        ],
      },
    ]);
    expect((await run(fine, "xlsx")).error).toBeNull();
  });

  it("refuses thousands of entries", async () => {
    const result = await run(xlsxWithEntries(MAX_ZIP_ENTRIES + 1), "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
  });
});

describe("merged cells", () => {
  it(`applies ${String(MAX_MERGES)} ranges over 50 000 rows without a quadratic pass, the event loop free`, async () => {
    const result = await run(xlsxWithMerges(50_000, MAX_MERGES), "xlsx");
    expect(result.error).toBeNull();
    expect(result.rows[1]!.cells).toEqual(["Geely", "A-1", 1001]);
    expect(result.ms).toBeLessThan(15_000);
    expect(result.stallMs).toBeLessThan(500);
  }, 30_000);

  it("refuses a sheet merging more ranges than a price list has", async () => {
    const result = await run(xlsxWithMerges(100, MAX_MERGES + 1), "xlsx");
    expect(reasonOf(result.error)).toBe("broken");
  });
});

describe("a long reading", () => {
  it("gives the event loop its turns and stops when the job is stopped", async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) =>
      index === 0 ? ["Артикул", "Цена"] : [`A-${String(index)}`, index],
    );
    const bytes = writeXlsx([{ name: "Прайс", rows }]);
    const controller = new AbortController();
    let read = 0;
    const reading = readPriceFile(
      bytes,
      "xlsx",
      50_000,
      {
        row: () => {
          read++;
        },
        flush: () => Promise.resolve(),
      },
      controller.signal,
    );
    // A timer fires while the file is read: the loop is not held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("The job's time is up"));
    await expect(reading).rejects.toThrow("The job's time is up");
    expect(read).toBeLessThan(20_000);
  });

  it("keeps only what is read of a CSV line of a million separators", async () => {
    const line = `Артикул;Цена;${";".repeat(1_000_000)}\nA-1;100;${"x".repeat(2 * MB)}\n`;
    const result = await run(Buffer.from(line), "csv");
    expect(result.error).toBeNull();
    expect(result.rows[0]!.cells.length).toBeLessThanOrEqual(100);
    expect(result.growthMb).toBeLessThan(200);
  });

  it("finds what the upload left to the worker in a large CSV", async () => {
    const lines = ["Артикул;Цена"];
    for (let index = 1; index < 9_000; index++) lines.push(`X${String(index)};100`);
    const quote = await run(Buffer.from(`${lines.join("\n")}\n"X0;100\n`), "csv");
    expect(reasonOf(quote.error)).toBe("broken");
    const many = await run(Buffer.from(lines.join("\n")), "csv", 100);
    expect(many.error).toMatchObject({ reason: "too_many_rows", extra: { limit: 100 } });
  });
});
