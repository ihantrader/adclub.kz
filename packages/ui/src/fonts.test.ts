import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("declares 400, 500 and 700 served by the app itself", () => {
    expect(faces.map((face) => face.weight)).toEqual([400, 500, 700]);
    expect(fontsCss).not.toMatch(/googleapis|gstatic/);
    for (const face of faces) expect(existsSync(join(fonts, face.file)), face.file).toBe(true);
  });

  it.each([400, 500, 700])(
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

  it("ships the SIL Open Font License next to the files", () => {
    const license = readFileSync(join(fonts, "OFL.txt"), "utf8");
    expect(license).toContain("SIL Open Font License, Version 1.1");
    expect(license).toContain("Onest Project Authors");
  });
});
