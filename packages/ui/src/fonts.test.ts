import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { typography, type TypographyToken } from "@adclub/ui-core";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";

const fonts = join(__dirname, "fonts");
const fontsCss = readFileSync(join(__dirname, "styles/fonts.css"), "utf8");

/** DESIGN.md 5: Kazakh letters (both cases), numero sign and tenge sign. */
const REQUIRED = "әғқңөұүһіӘҒҚҢӨҰҮҺІ№₸";

function open(file: string): fontkit.Font {
  const font = fontkit.openSync(join(fonts, file));
  if (!("characterSet" in font)) throw new Error(`${file} is a collection`);
  return font;
}

describe("Onest web fonts", () => {
  const faces = [
    ...fontsCss.matchAll(/font-weight: (\d+);[^}]*url\("\.\.\/fonts\/([^"]+)"\)/g),
  ].map((match) => ({ weight: Number(match[1]), file: match[2] ?? "" }));

  it("declares 300, 400 and 500 served by the app itself, and no 700 (D-068)", () => {
    expect(faces.map((face) => face.weight)).toEqual([300, 400, 500]);
    expect(fontsCss).not.toMatch(/font-weight: 700/);
    expect(existsSync(join(fonts, "onest-700.woff2"))).toBe(false);
    expect(fontsCss).not.toMatch(/googleapis|gstatic/);
    for (const face of faces) expect(existsSync(join(fonts, face.file)), face.file).toBe(true);
  });

  it.each([300, 400, 500])(
    "weight %i contains Kazakh letters, № and ₸, and tabular figures",
    (weight) => {
      const file = faces.find((face) => face.weight === weight)?.file ?? "";
      const font = open(file);
      expect(font.familyName.startsWith("Onest")).toBe(true);
      expect(font["OS/2"].usWeightClass).toBe(weight);
      const missing = [...REQUIRED].filter(
        (char) => !font.hasGlyphForCodePoint(char.codePointAt(0) ?? 0),
      );
      expect(missing).toEqual([]);
      expect(font.availableFeatures).toContain("tnum");
    },
  );

  /**
   * Every text token holds the tallest and deepest letters it can carry (Й, Ё
   * on top; Қ, Ң, Ұ below) inside its line, measured on the real glyphs of its
   * weight. Two layouts are checked: CSS half-leading (the web) and Android,
   * which shrinks ascent and descent in proportion when the line is shorter
   * than the font's own height. Tokens of digits carry digits, ₸ and "от".
   */
  it.each(Object.keys(typography) as TypographyToken[])(
    "token %s keeps its letters inside the line height",
    (token) => {
      const style = typography[token];
      const file = faces.find((face) => face.weight === style.fontWeight)?.file ?? "";
      const font = open(file);
      const letters = style.tabularNums ? "0123456789₸от" : `${REQUIRED}ЙЁйёQgjy`;
      const scale = style.fontSize / font.unitsPerEm;
      let top = 0;
      let bottom = 0;
      for (const char of letters) {
        const box = font.glyphForCodePoint(char.codePointAt(0) ?? 0).bbox;
        top = Math.max(top, box.maxY * scale);
        bottom = Math.max(bottom, -box.minY * scale);
      }
      const ascent = font.ascent * scale;
      const descent = -font.descent * scale;
      const line = style.lineHeight;
      // Web: the leading (negative when the line is short) is split in half.
      const halfLeading = (line - ascent - descent) / 2;
      expect(halfLeading + ascent, `${token} web top`).toBeGreaterThanOrEqual(top);
      expect(halfLeading + descent, `${token} web bottom`).toBeGreaterThanOrEqual(bottom);
      // Android: ascent and descent scaled by line / font height.
      const androidDescent = (line * descent) / (ascent + descent);
      expect(line - androidDescent, `${token} android top`).toBeGreaterThanOrEqual(top);
      expect(androidDescent, `${token} android bottom`).toBeGreaterThanOrEqual(bottom);
    },
  );

  it("ships the SIL Open Font License next to the files", () => {
    const license = readFileSync(join(fonts, "OFL.txt"), "utf8");
    expect(license).toContain("SIL Open Font License, Version 1.1");
    expect(license).toContain("Onest Project Authors");
  });
});
