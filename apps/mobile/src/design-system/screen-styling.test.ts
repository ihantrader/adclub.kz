import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native. They read the
// sources, because what they hold is a property of how the app is wired —
// a screen does not style itself: typography, colours and the frame of a
// screen come from the design system (TASK-078, ARCHITECTURE 4.74) — which
// no call of a pure function can show.
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

const screens = sourceFiles(join(src, "screens"))
  .concat(sourceFiles(join(src, "navigation")))
  .map((path) => ({
    path: path.slice(src.length + 1).replace(/\\/g, "/"),
    text: withoutComments(readFileSync(path, "utf8")),
  }));

describe("a screen does not style itself (TASK-078)", () => {
  it("sets no font size, family or line height of its own — text is a `Text` variant", () => {
    for (const file of screens) {
      // React Navigation's theme needs its fonts named; they are the tokens' families.
      if (file.path === "navigation/RootNavigator.tsx") continue;
      expect(file.text, file.path).not.toMatch(/\b(fontSize|fontFamily|lineHeight):/);
      expect(file.text, file.path).not.toMatch(/<Text(?![A-Za-z])[^>]*\bstyle=\{\{[^}]*color:/);
    }
  });

  it("names no colour by its value — colours are tokens of the theme", () => {
    for (const file of screens) {
      // The one exception: the frame and the hint drawn over the live camera
      // picture (M-GAR-04) are white on any theme, like the QR is black on white.
      if (file.path === "screens/garage/CarDocumentScreen.tsx") continue;
      expect(file.text, file.path).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
      expect(file.text, file.path).not.toMatch(/\brgba?\(/);
    }
  });

  it("draws no field, button or chip of its own: no `borderWidth` of a field in a screen", () => {
    for (const file of screens) {
      // The frame over the live camera picture is the same exception as its colour.
      if (file.path === "screens/garage/CarDocumentScreen.tsx") continue;
      // A hairline between rows is the one line a screen may draw (D-068).
      const borders = file.text.match(/borderWidth:\s*[^,}\n]+/g) ?? [];
      for (const border of borders) {
        expect(border, file.path).toMatch(/borderWidth:\s*(hairline|1)\b/);
      }
    }
  });

  it("builds its blocks from the design system's frame: ScreenBody and Section, not a body of its own", () => {
    for (const file of screens) {
      // The old body of a screen: the fields of the screen and the air under
      // the bar, drawn by the screen itself. A list that scrolls (a FlatList)
      // keeps the fields on its content, with the bottom air of the page too.
      const objects = file.text.match(/\{[^{}]*\}/g) ?? [];
      const bodies = objects.filter(
        (object) =>
          /paddingHorizontal:\s*layout\.screenPadding/.test(object) &&
          /paddingTop:\s*12\b/.test(object) &&
          !/paddingBottom:/.test(object),
      );
      expect(bodies, file.path).toEqual([]);
    }
  });
});
