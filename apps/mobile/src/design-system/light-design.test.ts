import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fontFamily, lightMinFontSize, typography } from "@adclub/ui-core";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native. They read the
// sources, because what they hold is a property of how the app is wired — the
// weight of text comes only from the typography tokens, so Light 300 can land
// only where a token of 24 and up puts it (D-068, TASK-030.B) — which no call
// of a pure function can show.
const src = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The code of a file without its comments, which talk about the very things these checks look for. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const files = sourceFiles(src).map((path) => ({
  path: path.slice(src.length + 1).replace(/\\/g, "/"),
  text: withoutComments(readFileSync(path, "utf8")),
}));

describe("light design: weights only from the typography tokens (D-068)", () => {
  it("Light 300 is a token of 24 and up and nothing else", () => {
    const light = Object.entries(typography).filter(([, style]) => style.fontWeight === 300);
    expect(light.length).toBeGreaterThan(0);
    for (const [token, style] of light) {
      expect(style.fontSize, token).toBeGreaterThanOrEqual(lightMinFontSize);
    }
  });

  it("no screen or component sets a font weight of its own", () => {
    for (const file of files) {
      // React Navigation's theme needs a `fontWeight` key; it is "normal" there,
      // the weight is the Onest family.
      const weights = file.text.match(/fontWeight:\s*"[^"]*"/g) ?? [];
      const allowed =
        file.path === "navigation/RootNavigator.tsx"
          ? weights.filter((w) => /"normal"/.test(w))
          : [];
      expect(weights, file.path).toEqual(allowed);
    }
  });

  it("a font family is picked only by the weight of a token", () => {
    for (const file of files) {
      const picks = file.text.match(/fontFamily\.native\[[^\]]+\]/g) ?? [];
      const literal = file.text.match(/"Onest-[A-Za-z]+"/g) ?? [];
      expect(literal, file.path).toEqual([]);
      for (const pick of picks) {
        // text.tsx registers one file per weight; that is not a choice of weight.
        if (file.path === "design-system/text.tsx" && /fontAssets/.test(file.text)) {
          if (/\[\s*\d+\s*\]/.test(pick)) continue;
        }
        // A number means a weight chosen by hand; it has to come from a token.
        expect(pick, file.path).not.toMatch(/\[\s*\d+\s*\]/);
        expect(pick, file.path).toMatch(/style\.fontWeight|typography\.\w+\.fontWeight/);
      }
    }
  });

  it("no Bold anywhere: the app registers Light, Regular and Medium", () => {
    expect(Object.values(fontFamily.native)).toEqual([
      "Onest-Light",
      "Onest-Regular",
      "Onest-Medium",
    ]);
    for (const file of files) expect(file.text, file.path).not.toMatch(/Onest-Bold|\b700\b/);
  });
});

describe("light design: thin lines (DESIGN.md 7.6, D-068)", () => {
  it("dividers between rows are hairlines", () => {
    for (const file of files) {
      const dividers =
        file.text.match(/border(Top|Bottom)Width:\s*(?:[^,}\n]*\?\s*0\s*:\s*)?\d+(?!\.)/g) ?? [];
      expect(
        dividers.filter((divider) => !/:\s*0$/.test(divider)),
        file.path,
      ).toEqual([]);
      // A divider drawn as a view one point high (the hidden code input is 1 × 1, not a line).
      const lineViews = (file.text.match(/^.*\bheight:\s*1\b(?!\.).*$/gm) ?? []).filter(
        (rule) => !/\bwidth:\s*1\b/.test(rule),
      );
      expect(lineViews, file.path).toEqual([]);
    }
  });
});
