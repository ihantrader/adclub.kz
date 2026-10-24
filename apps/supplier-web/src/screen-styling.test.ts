import { describe, expect, it } from "vitest";
import appCss from "./app.css?raw";

/**
 * «Экран не стилизует сам» (TASK-079, ARCHITECTURE 4.75): the cabinet's
 * screens are built from `@adclub/ui` and the layout classes of `app.css`;
 * a colour is a token, never a value, and a screen sets no inline styles
 * of its own.
 */
const screens = import.meta.glob<string>("./**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The inline styles allowed: the width of the upload's progress bar is data,
 * not design; the scanner hands the dark theme's tokens to its CSS variables
 * (the camera is dark in both themes, `cameraColors`).
 */
const ALLOWED_INLINE = [
  /style=\{\{ width: `\$\{String\(Math\.round\(uploading\.fraction \* 100\)\)\}%` \}\}/,
  /style=\{cameraColors\}/,
];

describe("the cabinet's screens don't style themselves", () => {
  it("reads every screen", () => {
    expect(Object.keys(screens).length).toBeGreaterThan(30);
  });

  it("set no inline styles", () => {
    const found = Object.entries(screens).flatMap(([file, text]) =>
      text
        .split("\n")
        .filter((line) => line.includes("style={"))
        .filter((line) => !ALLOWED_INLINE.some((allowed) => allowed.test(line)))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });

  it("name colours and fonts only by tokens in app.css", () => {
    const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.length).toBeGreaterThan(1000);
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(css.match(/\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([]);
    expect(css.match(/font-family\s*:/g) ?? []).toEqual([]);
  });
});
