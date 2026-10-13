import { priceExportHeader, priceExportRow, type PriceExportOffer } from "@adclub/domain";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { readPriceFile } from "./price-file";
import type { FileRow } from "./rows";
import { rowXml, streamXlsx, type XlsxCell } from "./xlsx-stream";

const OFFER: PriceExportOffer = {
  itemId: "5f0c2a4e-1d1b-4c55-9a3e-0f7d2a1b9c11",
  supplierSku: null,
  catalogArticle: "04465-0K090",
  brand: "Geely",
  supplierName: null,
  catalogName: "Колодки «Атлас» & <передние>",
  price: 12_500,
  availability: "in_stock",
  leadDays: 0,
  status: "active",
  pickup: true,
  delivery: false,
  warrantyMonths: null,
  warrantyText: null,
};

async function* batches(count: number, size: number) {
  for (let start = 0; start < count; start += size) {
    const batch: XlsxCell[][] = [];
    for (let at = start; at < Math.min(count, start + size); at++) {
      batch.push(priceExportRow({ ...OFFER, price: 1000 + at }, "ru"));
    }
    yield batch;
  }
}

async function written(count: number): Promise<{ bytes: Buffer; chunks: number; rows: number }> {
  const chunks: Uint8Array[] = [];
  const { rows } = await streamXlsx({
    sheet: { name: "Прайс", widths: [38, 18, 14, 50, 12, 16, 10, 12, 12, 16], hidden: [0] },
    header: priceExportHeader("ru"),
    rows: batches(count, 1000),
    second: { name: "Подсказка", lines: ["Строка один", "Строка два"] },
    write: (chunk) => {
      chunks.push(chunk);
    },
  });
  return { bytes: Buffer.concat(chunks), chunks: chunks.length, rows };
}

describe("the streamed workbook of «Скачать мой прайс» (TASK-048)", () => {
  it("is read back by the price list reader: header, rows, the hidden first column", async () => {
    const { bytes, rows } = await written(3);
    expect(rows).toBe(3);
    const read: FileRow[] = [];
    const facts = await readPriceFile(bytes, "xlsx", 1000, {
      row: (row) => read.push(row),
      flush: () => Promise.resolve(),
    });
    expect(facts.sheetName).toBe("Прайс");
    expect(read[0]!.cells.slice(0, 4)).toEqual(["item_id", "Артикул", "Бренд", "Название"]);
    expect(read).toHaveLength(4);
    expect(read[1]!.cells.slice(0, 6)).toEqual([
      OFFER.itemId,
      "04465-0K090",
      "Geely",
      "Колодки «Атлас» & <передние>",
      1000,
      "В наличии",
    ]);
    const sheet = strFromU8(unzipSync(new Uint8Array(bytes))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain('<col min="1" max="1" width="38" customWidth="1" hidden="1"/>');
    expect(sheet).toContain('state="frozen"');
  });

  it("goes out in pieces as the rows come, not as one whole file", async () => {
    const { chunks, rows, bytes } = await written(5_000);
    expect(rows).toBe(5_000);
    expect(chunks).toBeGreaterThan(4);
    const read: FileRow[] = [];
    await readPriceFile(bytes, "xlsx", 50_000, {
      row: (row) => read.push(row),
      flush: () => Promise.resolve(),
    });
    expect(read).toHaveLength(5_001);
    expect(read.at(-1)!.cells[4]).toBe(1000 + 4_999);
  }, 30_000);

  it("writes a header alone when there are no offers, and drops what XML can't hold", async () => {
    const { bytes, rows } = await written(0);
    expect(rows).toBe(0);
    const sheet = strFromU8(unzipSync(new Uint8Array(bytes))["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("item_id");
    expect(rowXml(2, ["a\u0001b", null, 5])).toBe(
      '<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">ab</t></is></c><c r="C2"><v>5</v></c></row>',
    );
  });
});
