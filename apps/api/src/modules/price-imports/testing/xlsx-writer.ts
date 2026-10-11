import { strToU8, zipSync } from "fflate";

/**
 * A small `.xlsx` writer for tests and the example files (TASK-046): just
 * enough of the format to build the workbooks a price list arrives in —
 * several sheets, hidden ones, shared and inline strings, numbers, dates in
 * a date format, booleans, merged ranges. Not a product feature: the
 * cabinet's own export comes with TASK-048.
 */

export type XlsxValue = string | number | boolean | Date | null | undefined;

export interface XlsxSheet {
  name: string;
  /** Rows from the top; a row may be `null` (left empty). */
  rows: (XlsxValue[] | null)[];
  /** Ranges like `A1:F1`. */
  merges?: string[];
  hidden?: boolean;
  /** The row number of the first row (1 by default) — to leave rows above empty. */
  firstRow?: number;
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function serial(date: Date): number {
  return (date.getTime() - EXCEL_EPOCH) / (24 * 60 * 60 * 1000);
}

export function writeXlsx(
  sheets: XlsxSheet[],
  options: { inlineStrings?: boolean; prefix?: string } = {},
): Buffer {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const stringRef = (text: string) => {
    let index = sharedIndex.get(text);
    if (index === undefined) {
      index = shared.length;
      shared.push(text);
      sharedIndex.set(text, index);
    }
    return index;
  };
  const p = options.prefix ? `${options.prefix}:` : "";
  const ns = options.prefix
    ? `xmlns:${options.prefix}="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    : `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;

  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, sheetIndex) => {
    const parts: string[] = [];
    const first = sheet.firstRow ?? 1;
    sheet.rows.forEach((row, rowIndex) => {
      if (!row) return;
      const rowNo = first + rowIndex;
      const cells: string[] = [];
      row.forEach((value, column) => {
        if (value === null || value === undefined) return;
        const ref = `${columnName(column)}${String(rowNo)}`;
        if (typeof value === "number") {
          cells.push(`<${p}c r="${ref}"><${p}v>${String(value)}</${p}v></${p}c>`);
        } else if (typeof value === "boolean") {
          cells.push(`<${p}c r="${ref}" t="b"><${p}v>${value ? 1 : 0}</${p}v></${p}c>`);
        } else if (value instanceof Date) {
          cells.push(`<${p}c r="${ref}" s="1"><${p}v>${String(serial(value))}</${p}v></${p}c>`);
        } else if (options.inlineStrings) {
          cells.push(
            `<${p}c r="${ref}" t="inlineStr"><${p}is><${p}t xml:space="preserve">${escape(value)}</${p}t></${p}is></${p}c>`,
          );
        } else {
          cells.push(`<${p}c r="${ref}" t="s"><${p}v>${String(stringRef(value))}</${p}v></${p}c>`);
        }
      });
      parts.push(`<${p}row r="${String(rowNo)}">${cells.join("")}</${p}row>`);
    });
    const merges =
      sheet.merges && sheet.merges.length > 0
        ? `<${p}mergeCells count="${String(sheet.merges.length)}">${sheet.merges
            .map((ref) => `<${p}mergeCell ref="${ref}"/>`)
            .join("")}</${p}mergeCells>`
        : "";
    files[`xl/worksheets/sheet${String(sheetIndex + 1)}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}worksheet ${ns}><${p}sheetData>${parts.join("")}</${p}sheetData>${merges}</${p}worksheet>`,
    );
  });

  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map(
        (_, index) =>
          `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join(
        "",
      )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  );
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escape(sheet.name)}" sheetId="${String(index + 1)}"${sheet.hidden ? ' state="hidden"' : ""} r:id="rId${String(index + 1)}"/>`,
      )
      .join("")}</sheets></workbook>`,
  );
  const styles = sheets.length + 1;
  const strings = sheets.length + 2;
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId${String(styles)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${String(strings)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  );
  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(shared.length)}" uniqueCount="${String(shared.length)}">${shared
      .map((text) => `<si><t xml:space="preserve">${escape(text)}</t></si>`)
      .join("")}</sst>`,
  );
  // A fixed time of every entry: the same workbook gives the same bytes.
  return Buffer.from(zipSync(files, { level: 6, mtime: new Date(Date.UTC(2026, 9, 1)) }));
}
