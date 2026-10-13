import { strToU8, Zip, ZipDeflate } from "fflate";

/**
 * Writing an `.xlsx` as a stream (TASK-048 «Скачать мой прайс»; ARCHITECTURE
 * 12.4, 4.68): the same small subset of the format the example files of
 * TASK-046 are written with (`testing/xlsx-writer.ts`), but the first sheet
 * goes out row by row as it is read from the database — the file is never
 * whole in memory. Strings are inline (no shared table to collect first);
 * the first row is bold and frozen; columns can be hidden (`item_id`).
 */

export type XlsxCell = string | number | null;

export interface XlsxStreamSheet {
  name: string;
  /** Widths of the columns in characters, one per column. */
  widths: readonly number[];
  /** 0-based columns hidden from view. */
  hidden?: readonly number[];
}

const SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** What XML 1.0 can't hold at all, and the characters it escapes. */
function escape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** One row of cells as SheetML; `style` 1 — bold (the header). */
export function rowXml(rowNo: number, cells: readonly XlsxCell[], style = 0): string {
  const parts: string[] = [];
  cells.forEach((value, column) => {
    if (value === null || value === "") return;
    const ref = `${columnName(column)}${String(rowNo)}`;
    const s = style > 0 ? ` s="${String(style)}"` : "";
    if (typeof value === "number") {
      if (Number.isFinite(value)) parts.push(`<c r="${ref}"${s}><v>${String(value)}</v></c>`);
      return;
    }
    parts.push(
      `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`,
    );
  });
  return `<row r="${String(rowNo)}">${parts.join("")}</row>`;
}

function sheetHead(sheet: XlsxStreamSheet, freezeHeader: boolean): string {
  const hidden = new Set(sheet.hidden ?? []);
  const cols = sheet.widths
    .map(
      (width, index) =>
        `<col min="${String(index + 1)}" max="${String(index + 1)}" width="${String(width)}" customWidth="1"${hidden.has(index) ? ' hidden="1"' : ""}/>`,
    )
    .join("");
  const views = freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  return `${XML}<worksheet xmlns="${SPREADSHEET}">${views}<cols>${cols}</cols><sheetData>`;
}

const SHEET_TAIL = "</sheetData></worksheet>";

/**
 * A workbook of two sheets: the first one streamed (`rows`, after the
 * header), the second one small and written at once (a hint). The bytes go
 * to `write` as they are made; it returns a promise when the reader is
 * slower (the HTTP response's back pressure).
 */
export async function streamXlsx(options: {
  sheet: XlsxStreamSheet;
  header: readonly XlsxCell[];
  rows: AsyncIterable<readonly (readonly XlsxCell[])[]>;
  second: { name: string; lines: readonly string[] };
  write: (chunk: Uint8Array) => Promise<void> | void;
}): Promise<{ rows: number }> {
  const pending: Uint8Array[] = [];
  let failure: Error | null = null;
  let finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) failure = error;
    else pending.push(data);
    if (final) finished = true;
  });
  const flush = async () => {
    if (failure) throw failure;
    while (pending.length > 0) await options.write(pending.shift()!);
  };
  const whole = (name: string, text: string) => {
    const file = new ZipDeflate(name, { level: 6 });
    zip.add(file);
    file.push(strToU8(text), true);
  };

  whole(
    "[Content_Types].xml",
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  );
  whole(
    "_rels/.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  whole(
    "xl/workbook.xml",
    `${XML}<workbook xmlns="${SPREADSHEET}" xmlns:r="${RELATIONSHIPS}"><sheets><sheet name="${escape(options.sheet.name)}" sheetId="1" r:id="rId1"/><sheet name="${escape(options.second.name)}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  );
  whole(
    "xl/_rels/workbook.xml.rels",
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`,
  );
  whole(
    "xl/styles.xml",
    `${XML}<styleSheet xmlns="${SPREADSHEET}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
  );
  whole(
    "xl/worksheets/sheet2.xml",
    `${sheetHead({ name: options.second.name, widths: [120] }, false)}${options.second.lines
      .map((line, index) => rowXml(index + 1, [line]))
      .join("")}${SHEET_TAIL}`,
  );
  await flush();

  const sheet = new ZipDeflate("xl/worksheets/sheet1.xml", { level: 6 });
  zip.add(sheet);
  sheet.push(strToU8(sheetHead(options.sheet, true) + rowXml(1, options.header, 1)));
  let rowNo = 1;
  for await (const batch of options.rows) {
    const text = batch.map((cells) => rowXml(++rowNo, cells)).join("");
    if (text !== "") sheet.push(strToU8(text));
    await flush();
  }
  sheet.push(strToU8(SHEET_TAIL), true);
  zip.end();
  await flush();
  if (!finished) throw new Error("The workbook was not finished");
  return { rows: rowNo - 1 };
}
