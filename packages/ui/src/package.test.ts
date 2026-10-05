import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Importing the package loads its styles (`dist/index.js` imports
 * `./styles/*.css`). A bundler drops such imports when it believes the
 * modules have no side effects: with `"sideEffects": ["*.css"]` the
 * production builds of the cabinet and the admin panel shipped without the
 * theme, the components' styles and the fonts (found in TASK-031; the dev
 * server never shows it).
 */
describe("package.json of @adclub/ui", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as {
    sideEffects: string[];
  };

  it("keeps the styles and the module that imports them in every build", () => {
    expect(manifest.sideEffects).toContain("**/*.css");
    expect(manifest.sideEffects).toContain("./dist/index.js");
  });
});
