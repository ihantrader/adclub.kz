import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyPriceRow,
  findPriceHeader,
  HEADER_SEARCH_ROWS,
  priceHeaderKey,
  readPriceRow,
  recognizePriceColumns,
  type PriceCell,
} from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { priceFileFormat, readPriceFile } from "../file/price-file";
import type { FileRow } from "../file/rows";
import { PRICE_SAMPLE_FILES } from "./price-samples";

/**
 * The example price lists through the whole reading the worker does — the
 * file into rows, the header, the service rows, the roles, the values — but
 * without a database (TASK-046 AC-3, AC-5). The integration test goes the
 * same way through the API and the worker.
 */

/** The defaults of `offer_price_min_kzt`, `offer_price_max_kzt`, `offer_lead_days_max`. */
const limits = { priceMin: 1, priceMax: 100_000_000, leadDaysMax: 90 };

async function read(file: string) {
  const bytes = readFileSync(resolve(__dirname, "../../../../fixtures/price-imports", file));
  const format = priceFileFormat(bytes);
  const rows: FileRow[] = [];
  await readPriceFile(bytes, format, 50_000, {
    row: (row) => rows.push(row),
    flush: () => Promise.resolve(),
  });
  const headerIndex = findPriceHeader(rows.slice(0, HEADER_SEARCH_ROWS).map((row) => row.cells));
  const header = headerIndex === null ? null : rows[headerIndex]!.cells;
  const key = header ? priceHeaderKey(header) : null;
  const kinds = rows.map((row, index) =>
    headerIndex !== null && index < headerIndex
      ? "title"
      : index === headerIndex
        ? "header"
        : classifyPriceRow(row.cells, key),
  );
  const data = rows.filter((_, index) => kinds[index] === "data");
  const width = Math.max(...rows.map((row) => row.cells.length));
  const guesses = recognizePriceColumns(
    header,
    data.slice(0, 30).map((row) => row.cells),
    width,
  );
  const roles = guesses.map((guess) => guess.role);
  const readings = data.map((row) => readPriceRow(row.cells as PriceCell[], roles, limits));
  return {
    format,
    rows,
    header,
    headerRowNo: headerIndex === null ? null : rows[headerIndex]!.rowNo,
    kinds,
    data,
    guesses,
    roles,
    readings,
  };
}

describe("the example price lists", () => {
  it("are what the builders give", async () => {
    for (const sample of PRICE_SAMPLE_FILES) {
      const bytes = readFileSync(
        resolve(__dirname, "../../../../fixtures/price-imports", sample.file),
      );
      expect(bytes.equals(sample.build()), sample.file).toBe(true);
    }
  });

  it("1C export: the header under the title, «Опт» left to the supplier, «по запросу» an error", async () => {
    const file = await read("1c-export.xlsx");
    expect(file.format).toBe("xlsx");
    expect(file.headerRowNo).toBe(6);
    expect(file.roles).toEqual([
      "ignore",
      "article",
      "name",
      "ignore",
      "ignore",
      "price",
      "availability",
    ]);
    expect(file.guesses[1]!.source).toBe("header");
    expect(file.data).toHaveLength(1240);
    expect(file.kinds.filter((kind) => kind === "group")).toHaveLength(4);
    expect(file.kinds.filter((kind) => kind === "total")).toHaveLength(1);
    expect(file.kinds.filter((kind) => kind === "title")).toHaveLength(4);
    const errors = file.readings.filter((reading) => reading.errors.length > 0);
    expect(errors).toHaveLength(12);
    expect(errors.every((reading) => reading.errors[0]!.code === "price_not_number")).toBe(true);
  });

  it("CSV in Windows-1251 with «;»: every role by its header, Cyrillic intact", async () => {
    const file = await read("cp1251-semicolon.csv");
    expect(file.format).toBe("csv");
    expect(file.roles).toEqual(["article", "brand", "name", "price", "availability", "lead_days"]);
    expect(file.header).toEqual([
      "Артикул",
      "Производитель",
      "Наименование",
      "Цена",
      "Наличие",
      "Срок поставки, дн",
    ]);
    expect(file.readings.every((reading) => reading.errors.length === 0)).toBe(true);
    const onOrder = file.readings.find((reading) => reading.parsed.availability === "on_order");
    expect(onOrder?.parsed.leadDays).toBeGreaterThanOrEqual(4);
    expect(file.readings[0]!.parsed.name).toMatch(/^[А-Яа-я]/);
  });

  it("Kazakh headers: every role recognised", async () => {
    const file = await read("kazakh-columns.xlsx");
    expect(file.roles).toEqual(["article", "brand", "name", "price", "availability", "lead_days"]);
    expect(file.readings.every((reading) => reading.errors.length === 0)).toBe(true);
    expect(new Set(file.readings.map((reading) => reading.parsed.availability))).toEqual(
      new Set(["in_stock", "on_order"]),
    );
  });

  it("errors: each bad row with its reason, the good rows read", async () => {
    const file = await read("with-errors.csv");
    expect(file.readings.map((reading) => reading.errors.map((error) => error.code))).toEqual([
      [],
      ["price_missing"],
      ["price_not_number"],
      ["price_out_of_range"],
      ["price_out_of_range"],
      ["no_article_or_name"],
      ["lead_days_out_of_range"],
      [],
      ["price_not_number"],
      [],
    ]);
  });
});
