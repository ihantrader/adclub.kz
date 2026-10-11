import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { PriceFileError } from "../price-import-errors";
import { writeXlsx } from "../testing/xlsx-writer";
import { checkPriceFile, priceFileFormat, readPriceFile } from "./price-file";
import { decodeCsv, detectDelimiter } from "./csv";
import type { FileRow } from "./rows";
import { excelDate, isDateFormat } from "./xlsx";

async function rowsOf(bytes: Buffer, format: "xlsx" | "csv", maxRows = 50_000) {
  const rows: FileRow[] = [];
  const facts = await readPriceFile(bytes, format, maxRows, {
    row: (row) => rows.push(row),
    flush: () => Promise.resolve(),
  });
  return { rows, facts };
}

function refusal(action: () => unknown): PriceFileError {
  try {
    action();
  } catch (error) {
    if (error instanceof PriceFileError) return error;
    throw error;
  }
  throw new Error("Expected a refusal");
}

async function refusalOf(action: () => Promise<unknown>): Promise<PriceFileError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof PriceFileError) return error;
    throw error;
  }
  throw new Error("Expected a refusal");
}

function win1251(text: string): Buffer {
  // Cyrillic letters of Windows-1251: А-я at 0xC0-0xFF, Ё 0xA8, ё 0xB8, № 0xB9.
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else if (character === "Ё") bytes.push(0xa8);
    else if (character === "ё") bytes.push(0xb8);
    else if (character === "№") bytes.push(0xb9);
    else throw new Error(`No Windows-1251 byte for ${character}`);
  }
  return Buffer.from(bytes);
}

describe("what a file is", () => {
  it("is decided by its content, not its name", () => {
    expect(priceFileFormat(writeXlsx([{ name: "Лист1", rows: [["a", 1]] }]))).toBe("xlsx");
    expect(priceFileFormat(Buffer.from("Артикул;Цена\nX1;100\n"))).toBe("csv");
  });

  it.each([
    ["pdf", Buffer.from("%PDF-1.7\n…"), "not_a_table", "pdf"],
    ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), "not_a_table", "image"],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "not_a_table", "image"],
    ["empty", Buffer.alloc(0), "empty", null],
  ])("refuses %s", (_, bytes, reason, detected) => {
    const error = refusal(() => priceFileFormat(bytes));
    expect(error.reason).toBe(reason);
    expect(error.details().detected).toBe(detected);
  });

  it("tells the old .xls from an Excel file under a password", () => {
    const ole = Buffer.from([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...Array(500).fill(0),
    ]);
    expect(refusal(() => priceFileFormat(ole)).reason).toBe("old_excel");
    const encrypted = Buffer.concat([ole, Buffer.from("EncryptedPackage", "utf16le")]);
    expect(refusal(() => priceFileFormat(encrypted)).reason).toBe("encrypted");
  });

  it("refuses an archive that is not a workbook, and a damaged one", () => {
    const docx = Buffer.from(zipSync({ "word/document.xml": strToU8("<w/>") }));
    const error = refusal(() => checkPriceFile(docx, 100));
    expect(error.reason).toBe("not_a_table");
    expect(error.details().detected).toBe("docx");
    const xlsx = writeXlsx([{ name: "Лист1", rows: [["a", 1]] }]);
    expect(refusal(() => checkPriceFile(xlsx.subarray(0, xlsx.length - 40), 100)).reason).toBe(
      "broken",
    );
  });

  it("refuses a web page saved as .xls and a text without columns", () => {
    expect(
      refusal(() =>
        checkPriceFile(Buffer.from("<html><table><tr><td>1</td></tr></table>"), 100),
      ).details().detected,
    ).toBe("html");
    expect(
      refusal(() => checkPriceFile(Buffer.from("Добрый день!\nВысылаем прайс.\n"), 100)).details()
        .detected,
    ).toBe("text");
  });
});

describe("CSV", () => {
  it("reads UTF-8 with and without a byte order mark", async () => {
    const text = "Артикул;Наименование;Цена\n04465-0K090;Колодки;12 500\n";
    for (const bytes of [
      Buffer.from(text),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    ]) {
      const { rows, facts } = await rowsOf(bytes, "csv");
      expect(facts).toMatchObject({ encoding: "utf-8", delimiter: ";" });
      expect(rows).toEqual([
        { rowNo: 1, cells: ["Артикул", "Наименование", "Цена"] },
        { rowNo: 2, cells: ["04465-0K090", "Колодки", "12 500"] },
      ]);
    }
  });

  it("reads Windows-1251 with «;» without breaking the Cyrillic", async () => {
    const bytes = win1251(
      "Артикул;Наименование;Цена, тг\r\nGDB3534;Колодки тормозные передние;9 800\r\n",
    );
    expect(decodeCsv(bytes).encoding).toBe("windows-1251");
    const { rows } = await rowsOf(bytes, "csv");
    expect(rows[1]!.cells).toEqual(["GDB3534", "Колодки тормозные передние", "9 800"]);
  });

  it("reads UTF-16 with a mark, as Excel saves «Unicode text»", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Артикул\tЦена\nX1\t100\n", "utf16le"),
    ]);
    const { rows, facts } = await rowsOf(bytes, "csv");
    expect(facts).toMatchObject({ encoding: "utf-16le", delimiter: "\t" });
    expect(rows[1]!.cells).toEqual(["X1", "100"]);
  });

  it("refuses an encoding that is neither UTF-8 nor Cyrillic Windows-1251", () => {
    // Latin-1 accented text: valid Windows-1251 bytes that read as nonsense.
    const bytes = Buffer.from([
      0x50, 0x72, 0x69, 0x78, 0x3b, 0x4e, 0x6f, 0x6d, 0x0a, 0xe9, 0xe8, 0xe0, 0x3b, 0xa9, 0xae,
      0xb1, 0xbc, 0x0a, 0xa4, 0xa6, 0xa7, 0xb5, 0x3b, 0x96, 0x97, 0x8b,
    ]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
    expect(refusal(() => checkPriceFile(bytes, 100)).reason).toBe("encoding");
  });

  it("finds the separator under a title of a 1C export", () => {
    expect(
      detectDelimiter(
        'ТОО «Автомир Степь», г. Алматы\nПрайс на 10.10.2026\n\nАртикул;Наименование;Цена\nX1;"Фильтр, масляный";100\nX2;Свеча;200\n',
      ),
    ).toBe(";");
    expect(detectDelimiter("Артикул,Цена\nX1,100\nX2,200\n")).toBe(",");
    expect(detectDelimiter("Артикул\tЦена\nX1\t100\n")).toBe("\t");
  });

  it("follows RFC 4180 and numbers the rows as the file does, empty ones counted", async () => {
    const text =
      'Артикул;Наименование;Цена\n\n"X;1";"Фильтр ""Mann""\nмасляный";100\n;;\nX2;Свеча;200';
    const { rows } = await rowsOf(Buffer.from(text), "csv");
    expect(rows).toEqual([
      { rowNo: 1, cells: ["Артикул", "Наименование", "Цена"] },
      { rowNo: 3, cells: ["X;1", 'Фильтр "Mann"\nмасляный', "100"] },
      { rowNo: 5, cells: ["X2", "Свеча", "200"] },
    ]);
  });

  it("refuses a quote that is never closed, with its line", () => {
    const error = refusal(() =>
      checkPriceFile(Buffer.from('А;Б\nX1;"Фильтр;100\nX2;Свеча;200\n'), 100),
    );
    expect(error.reason).toBe("broken");
    expect(error.details().line).toBe(2);
  });

  it("refuses more rows than the limit", () => {
    const text = ["А;Б", ...Array.from({ length: 101 }, (_, i) => `X${i};${i}`)].join("\n");
    const error = refusal(() => checkPriceFile(Buffer.from(text), 100));
    expect(error.reason).toBe("too_many_rows");
    expect(error.details().limit).toBe(100);
  });
});

describe("Excel", () => {
  it("reads values, not formats: numbers, dates, booleans, shared and inline strings", async () => {
    for (const inlineStrings of [false, true]) {
      const bytes = writeXlsx(
        [
          {
            name: "Прайс",
            rows: [
              ["Артикул", "Наименование", "Цена", "Дата", "Есть"],
              ["04465-0K090", "Колодки", 12500.5, new Date(Date.UTC(2026, 9, 11)), true],
            ],
          },
        ],
        { inlineStrings },
      );
      const { rows, facts } = await rowsOf(bytes, "xlsx");
      expect(facts.sheetName).toBe("Прайс");
      expect(rows[1]).toEqual({
        rowNo: 2,
        cells: ["04465-0K090", "Колодки", 12500.5, "2026-10-11", "TRUE"],
      });
    }
  });

  it("takes the first visible sheet with a table", async () => {
    const bytes = writeXlsx([
      {
        name: "Скрытый",
        hidden: true,
        rows: [
          ["Артикул", "Цена"],
          ["H1", 1],
        ],
      },
      { name: "Обложка", rows: [["Прайс-лист"]] },
      { name: "Пустой", rows: [] },
      {
        name: "Товары",
        rows: [
          ["Артикул", "Цена"],
          ["X1", 100],
        ],
      },
      {
        name: "Ещё",
        rows: [
          ["Артикул", "Цена"],
          ["Y1", 200],
        ],
      },
    ]);
    const { rows, facts } = await rowsOf(bytes, "xlsx");
    expect(facts.sheetName).toBe("Товары");
    expect(rows.map((row) => row.cells[0])).toEqual(["Артикул", "X1"]);
  });

  it("numbers rows as the sheet does and skips empty ones", async () => {
    const bytes = writeXlsx([
      { name: "Лист1", firstRow: 6, rows: [["Артикул", "Цена"], null, ["X1", 100]] },
    ]);
    const { rows } = await rowsOf(bytes, "xlsx");
    expect(rows.map((row) => row.rowNo)).toEqual([6, 8]);
  });

  it("puts a value merged over rows into each of them, one merged over columns into its first cell", async () => {
    const bytes = writeXlsx([
      {
        name: "Лист1",
        rows: [
          ["ТОО «Автомир Степь»"],
          ["Бренд", "Артикул", "Цена"],
          ["Geely", "04465-0K090", 12500],
          [null, "4050068800", 7300],
          [null, "1016051345", 3500],
          ["TRW", "GDB3534", 9800],
        ],
        merges: ["A1:C1", "A3:A5"],
      },
    ]);
    const { rows } = await rowsOf(bytes, "xlsx");
    expect(rows[0]!.cells).toEqual(["ТОО «Автомир Степь»"]);
    expect(rows.slice(2).map((row) => row.cells[0])).toEqual(["Geely", "Geely", "Geely", "TRW"]);
  });

  it("reads sheets whose tags carry a namespace prefix", async () => {
    const bytes = writeXlsx(
      [
        {
          name: "Лист1",
          rows: [
            ["Артикул", "Цена"],
            ["X1", 100],
          ],
        },
      ],
      {
        prefix: "x",
      },
    );
    const { rows } = await rowsOf(bytes, "xlsx");
    expect(rows[1]!.cells).toEqual(["X1", 100]);
  });

  it("refuses a workbook without a table and too many rows", async () => {
    expect(
      (
        await refusalOf(() =>
          rowsOf(writeXlsx([{ name: "Лист1", rows: [["Только заголовок"]] }]), "xlsx"),
        )
      ).reason,
    ).toBe("empty");
    const big = writeXlsx([
      { name: "Лист1", rows: [["А", "Б"], ...Array.from({ length: 150 }, (_, i) => [`X${i}`, i])] },
    ]);
    const error = await refusalOf(() => rowsOf(big, "xlsx", 100));
    expect(error.reason).toBe("too_many_rows");
  });

  it("refuses a sheet whose XML is damaged", async () => {
    const files = {
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      "xl/workbook.xml": strToU8(
        '<workbook xmlns:r="r"><sheets><sheet name="Л" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c',
      ),
    };
    const error = await refusalOf(() => rowsOf(Buffer.from(zipSync(files)), "xlsx"));
    expect(error.reason).toBe("broken");
  });
});

describe("dates of Excel", () => {
  it("are told by their format codes", () => {
    expect(isDateFormat("dd.mm.yyyy")).toBe(true);
    expect(isDateFormat("[$-419]d mmmm yyyy")).toBe(true);
    expect(isDateFormat('#,##0.00" ₸"')).toBe(false);
    expect(isDateFormat('0" дн."')).toBe(false);
    expect(isDateFormat("General")).toBe(false);
  });

  it("turn serial numbers into ISO dates", () => {
    expect(excelDate(46306, false)).toBe("2026-10-11");
    expect(excelDate(46306.5, false)).toBe("2026-10-11T12:00");
    expect(excelDate(44844, true)).toBe("2026-10-11");
  });
});
