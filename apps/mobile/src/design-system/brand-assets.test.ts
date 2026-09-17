import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fontFamily } from "@adclub/ui-core";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native.
const app = join(__dirname, "../..");
const fonts = join(app, "assets/fonts");
const REQUIRED = "әғқңөұүһіӘҒҚҢӨҰҮҺІ№₸";

const files: Record<number, string> = {
  400: "Onest-Regular.ttf",
  500: "Onest-Medium.ttf",
  700: "Onest-Bold.ttf",
};

describe("bundled Onest fonts", () => {
  it.each([400, 500, 700] as const)(
    "weight %i has Kazakh letters, № and ₸, and tabular figures",
    (weight) => {
      const font = fontkit.openSync(join(fonts, files[weight] ?? ""));
      if (!("characterSet" in font)) throw new Error("font collection");
      expect(font["OS/2"].usWeightClass).toBe(weight);
      expect(font.familyName.startsWith("Onest")).toBe(true);
      expect(
        [...REQUIRED].filter((char) => !font.hasGlyphForCodePoint(char.codePointAt(0) ?? 0)),
      ).toEqual([]);
      expect(font.availableFeatures).toContain("tnum");
    },
  );

  it("registers one family per weight, loaded from these files", () => {
    const source = readFileSync(join(__dirname, "text.tsx"), "utf8");
    for (const weight of [400, 500, 700] as const) {
      expect(fontFamily.native[weight]).toBe(files[weight]?.replace(".ttf", ""));
      expect(source).toContain(`assets/fonts/${files[weight]}`);
    }
  });

  it("ships the SIL Open Font License next to the files", () => {
    expect(readFileSync(join(fonts, "OFL.txt"), "utf8")).toContain(
      "SIL Open Font License, Version 1.1",
    );
  });
});

describe("app config brand assets", () => {
  const config = JSON.parse(readFileSync(join(app, "app.json"), "utf8")).expo;

  it("names the app and follows the theme for native UI", () => {
    expect(config.name).toBe("Asia Drive Club");
    expect(config.userInterfaceStyle).toBe("automatic");
    expect(config.backgroundColor).toBe("#0F1012");
  });

  it("points every icon, splash and notification icon at existing files", () => {
    const splash = config.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
    )[1];
    const notifications = config.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "expo-notifications",
    )[1];
    const paths = [
      config.icon,
      config.android.adaptiveIcon.foregroundImage,
      config.android.adaptiveIcon.backgroundImage,
      config.android.adaptiveIcon.monochromeImage,
      config.web.favicon,
      splash.image,
      notifications.icon,
    ];
    for (const path of paths) expect(existsSync(join(app, path)), path).toBe(true);
    expect(splash.backgroundColor).toBe("#0F1012");
    expect(config.android.adaptiveIcon.backgroundColor).toBe("#0F1012");
  });
});
