import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  darkColors,
  lightColors,
  radius,
  size,
  space,
  themes,
  typography,
  type ColorToken,
  type TypographyToken,
} from "./index";

const design = readFileSync(join(__dirname, "../../../DESIGN.md"), "utf8");

/** Rows of the markdown table that follows `heading`. */
function tableAfter(heading: string): string[][] {
  const start = design.indexOf(heading);
  if (start < 0) throw new Error(`DESIGN.md: section "${heading}" not found`);
  const lines = design.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows.slice(2); // header and separator
}

const ticks = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

describe("color tokens", () => {
  it("both themes define exactly the same keys", () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
    expect(themes.dark.colors).toBe(darkColors);
    expect(themes.light.colors).toBe(lightColors);
  });

  it("match every row of the DESIGN.md 7.2 table in both themes", () => {
    const rows = tableAfter("### 7.2 Цвета — токены");
    expect(rows.length).toBeGreaterThan(20);
    let checked = 0;
    for (const [tokenCell = "", darkCell = "", lightCell = ""] of rows) {
      const tokens = ticks(tokenCell) as ColorToken[];
      const dark = darkCell.includes("`") ? ticks(darkCell) : [darkCell];
      const light =
        lightCell === "то же" ? dark : lightCell.includes("`") ? ticks(lightCell) : [lightCell];
      tokens.forEach((token, index) => {
        const normalize = (value: string) =>
          value
            .replace(/\s/g, "")
            .replace(/(^|\D)\./g, (_, lead: string) => `${lead}0.`)
            .toLowerCase();
        expect(normalize(darkColors[token]), `${token} dark`).toBe(normalize(dark[index] ?? ""));
        expect(normalize(lightColors[token]), `${token} light`).toBe(normalize(light[index] ?? ""));
        checked += 1;
      });
    }
    // Every DESIGN.md token is implemented; `toast`/`onToast` come from 7.7.
    expect(checked).toBe(Object.keys(darkColors).length - 2);
  });

  it("toast colors follow DESIGN.md 7.7", () => {
    expect([darkColors.toast, darkColors.onToast]).toEqual([darkColors.fill, darkColors.text]);
    expect([lightColors.toast, lightColors.onToast]).toEqual(["#16171A", "#F2EFE8"]);
  });

  it("keeps QR black on white in both themes", () => {
    for (const colors of [darkColors, lightColors]) {
      expect([colors.qrFg, colors.qrBg]).toEqual(["#000000", "#FFFFFF"]);
    }
  });
});

describe("typography tokens", () => {
  it("match the DESIGN.md 7.4 table", () => {
    const rows = tableAfter("### 7.4 Типографика");
    expect(rows).toHaveLength(Object.keys(typography).length);
    for (const [tokenCell = "", metrics = "", weight = ""] of rows) {
      const token = ticks(tokenCell)[0] as TypographyToken;
      const [fontSize, lineHeight] = metrics.split("/").map((value) => Number(value.trim()));
      expect(typography[token], token).toMatchObject({
        fontSize,
        lineHeight,
        fontWeight: Number(weight),
      });
    }
  });

  it("keeps line height >= 1.25 for text, so Kazakh Қ, Ң, Ғ, Ұ are not clipped", () => {
    // Price and code tokens carry digits only (their DESIGN.md values are 1.1–1.2).
    const digitsOnly: TypographyToken[] = ["price", "priceS", "code", "codeXL"];
    for (const [token, style] of Object.entries(typography)) {
      if (digitsOnly.includes(token as TypographyToken)) continue;
      expect(style.lineHeight / style.fontSize, token).toBeGreaterThanOrEqual(1.25);
    }
  });

  it("uses tabular figures for prices and codes", () => {
    for (const token of ["price", "priceS", "code", "codeXL"] as const) {
      expect(typography[token].tabularNums).toBe(true);
    }
  });
});

describe("shape and size tokens", () => {
  it("match the DESIGN.md 7.6 radius table", () => {
    const rows = tableAfter("### 7.6 Форма");
    const expected: Record<string, number> = {};
    for (const [tokenCell = "", value = ""] of rows) {
      const name = ticks(tokenCell)[0] ?? "";
      if (value !== "—") expected[name] = Number(value);
    }
    expect(expected).toEqual({
      radiusXS: radius.xs,
      radiusS: radius.s,
      radiusM: radius.m,
      radiusL: radius.l,
    });
  });

  it("match DESIGN.md 7.5 spacing and sizes", () => {
    expect(Object.values(space)).toEqual([4, 8, 12, 16, 20, 24, 32, 40, 48]);
    expect(design).toContain("**Шкала отступов:** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48.");
    expect(size.touchTarget).toBe(48);
    expect(size.button).toEqual({ l: 52, m: 44, s: 36 });
    expect(design).toContain(
      "L — 52 (главное действие внизу экрана), M — 44 (в карточках), S — 36",
    );
  });
});
