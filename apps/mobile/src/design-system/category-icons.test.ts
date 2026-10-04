import { readFileSync } from "node:fs";
import { join } from "node:path";
import { categoryIcons } from "@adclub/contracts";
import { glyphGrid, uiGlyphs } from "@adclub/ui-core";
import { describe, expect, it } from "vitest";
import { categoryGlyphs } from "./category-glyphs";

// Plain Node checks: this file must not import react-native.

describe("category icons (TASK-010, TASK-030.A)", () => {
  it.each(categoryIcons)("%s has a glyph of the icon set", (icon) => {
    const glyph = categoryGlyphs[icon];
    expect(glyph.length).toBeGreaterThan(0);
    for (const part of glyph) expect(part.d).toMatch(/^[Mm][\d\s,.\-a-zA-Z]+$/);
  });

  it("knows no code the contract does not have", () => {
    expect(Object.keys(categoryGlyphs).sort()).toEqual([...categoryIcons].sort());
  });

  it("draws the glyphs on Phosphor's 256 grid with the Light stroke", () => {
    expect(glyphGrid).toEqual({ viewBox: "0 0 256 256", lightStroke: 12 });
  });
});

describe("semantic icons (TASK-030.A)", () => {
  it("every one has a glyph", () => {
    for (const glyph of Object.values(uiGlyphs)) expect(glyph.length).toBeGreaterThan(0);
  });

  it("the app draws no Tabler icon any more (D-067)", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).filter((name) => name.includes("tabler"))).toEqual(
      [],
    );
  });
});
