import type { VehicleImportFileInvalidDetails } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { ApiException } from "../../../common/errors";
import { readImportFile } from "./csv";

const HEADER = "make,model,generation,body,engine_code,transmission,drive,year_from,market";

function refusal(read: () => unknown): VehicleImportFileInvalidDetails {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    const api = error as ApiException;
    expect(api.code).toBe("VEHICLE_IMPORT_FILE_INVALID");
    expect(api.status).toBe(400);
    return api.options.details as VehicleImportFileInvalidDetails;
  }
  throw new Error("The file was taken");
}

const read = (text: string | Buffer, maxRows = 100) =>
  readImportFile(typeof text === "string" ? Buffer.from(text, "utf8") : text, maxRows);

describe("reading an import file", () => {
  it("reads a comma separated UTF-8 file, rows numbered as in a spreadsheet", () => {
    const file = read(`${HEADER}\nGeely,Coolray,I,crossover,JLH-3G15TD,dct,fwd,2020,kz\n`);
    expect(file.delimiter).toBe(",");
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]).toMatchObject({
      rowNumber: 2,
      values: { make: "Geely", model: "Coolray", year_from: "2020", market: "kz" },
    });
  });

  it("drops a byte order mark, finds the semicolon and keeps quotes, commas and line breaks inside a field", () => {
    const text = `${String.fromCharCode(0xfeff)}${HEADER.replaceAll(",", ";")}\r\n"Geely";"Atlas ""Pro"", 2";"I;\nNL";crossover;X;at;awd;2021;kz\r\n`;
    const file = read(text);
    expect(file.delimiter).toBe(";");
    expect(file.rows[0]!.values).toMatchObject({
      make: "Geely",
      model: 'Atlas "Pro", 2',
      generation: "I;\nNL",
    });
  });

  it("finds a tab as the separator and takes the header in any case, optional columns included", () => {
    const file = read(
      "MAKE\tModel\tgeneration\tbody\tengine_code\ttransmission\tdrive\tyear_from\tmarket\tengine_power_hp\n" +
        "Geely\tCoolray\tI\tcrossover\tX\tdct\tfwd\t2020\tkz\t177\n",
    );
    expect(file.delimiter).toBe("\t");
    expect(file.columns).toContain("engine_power_hp");
    expect(file.rows[0]!.values).toMatchObject({ make: "Geely", engine_power_hp: "177" });
  });

  it("skips blank rows but keeps the spreadsheet numbers of the rest", () => {
    const file = read(`${HEADER}\n\n,,,,,,,,\nGeely,Coolray,I,crossover,X,dct,fwd,2020,kz\n`);
    expect(file.rows.map((row) => row.rowNumber)).toEqual([4]);
  });

  it("leaves a row with more or fewer cells than the header to the check", () => {
    const file = read(`${HEADER}\nGeely,Coolray\n`);
    expect(file.rows[0]).toMatchObject({ rowNumber: 2, values: null, cells: ["Geely", "Coolray"] });
  });

  it("refuses a spreadsheet, a PDF, a picture and a binary file by their content", () => {
    expect(refusal(() => read(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))).toMatchObject({
      reason: "unsupported_format",
      detected: "xlsx",
    });
    expect(
      refusal(() => read(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))),
    ).toMatchObject({ detected: "xls" });
    expect(refusal(() => read(Buffer.from("%PDF-1.7\n", "latin1")))).toMatchObject({
      detected: "pdf",
    });
    expect(refusal(() => read(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toMatchObject({
      detected: "image",
    });
    expect(refusal(() => read(Buffer.from([0x6d, 0x61, 0x00, 0x6b])))).toMatchObject({
      reason: "unsupported_format",
      detected: "binary",
    });
  });

  it("refuses text that isn't UTF-8 with a hint", () => {
    expect(refusal(() => read(Buffer.from([0xff, 0xfe, 0x6d, 0x00])))).toMatchObject({
      reason: "encoding",
      detected: "utf-16",
    });
    // «Марка» in Windows-1251.
    const cp1251 = Buffer.from([0xcc, 0xe0, 0xf0, 0xea, 0xe0, 0x0a]);
    expect(refusal(() => read(cp1251))).toMatchObject({ reason: "encoding", detected: "unknown" });
  });

  it("refuses an empty file, a blank one and one with a header only", () => {
    expect(refusal(() => read(""))).toMatchObject({ reason: "empty" });
    expect(refusal(() => read(" \r\n\n "))).toMatchObject({ reason: "empty" });
    expect(refusal(() => read(`${HEADER}\n`))).toMatchObject({ reason: "no_rows" });
  });

  it("names missing, unknown and repeated columns", () => {
    expect(refusal(() => read("make,model\nGeely,Coolray\n"))).toMatchObject({
      reason: "missing_columns",
      columns: expect.arrayContaining(["generation", "market"]) as unknown,
    });
    expect(refusal(() => read(`${HEADER},colour\nx\n`))).toMatchObject({
      reason: "unknown_columns",
      columns: ["colour"],
    });
    expect(refusal(() => read(`${HEADER},make\nx\n`))).toMatchObject({
      reason: "duplicate_columns",
      columns: ["make"],
    });
  });

  it("refuses more rows than the limit", () => {
    const rows = Array.from({ length: 3 }, () => "Geely,Coolray,I,crossover,X,dct,fwd,2020,kz");
    expect(refusal(() => read([HEADER, ...rows].join("\n"), 2))).toMatchObject({
      reason: "too_many_rows",
      limit: 2,
    });
  });

  it("refuses a quote that is never closed, with its line", () => {
    expect(refusal(() => read(`${HEADER}\nGeely,"Coolray,I\n`))).toMatchObject({
      reason: "malformed",
      line: 2,
    });
  });
});
