import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import rule from "./no-relative-package-import.js";

const linter = new Linter();

function lint(filename, code) {
  // A relative (not leading-slash) path: flat config `files` globs match
  // against the cwd-relative path, not an absolute one.
  return linter.verify(
    code,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { sourceType: "module", ecmaVersion: "latest" },
        plugins: { local: { rules: { "no-relative-package-import": rule } } },
        rules: { "local/no-relative-package-import": "error" },
      },
    ],
    filename,
  );
}

describe("no-relative-package-import", () => {
  it("flags a relative import that reaches into another package's src", () => {
    const messages = lint(
      "apps/mobile/src/screens/foo.ts",
      'import { normalizeArticle } from "../../../../packages/domain/src/index";',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe("crossPackageRelativeImport");
  });

  it("flags a relative import that reaches into another app's src", () => {
    const messages = lint(
      "packages/domain/src/index.ts",
      'import { something } from "../../../apps/api/src/main";',
    );

    expect(messages).toHaveLength(1);
  });

  it("allows a relative import within the same package", () => {
    const messages = lint("packages/domain/src/foo.ts", 'import { bar } from "./bar";');

    expect(messages).toHaveLength(0);
  });

  it("ignores a package-name import (not relative)", () => {
    const messages = lint(
      "apps/api/src/main.ts",
      'import { normalizeArticle } from "@adclub/domain";',
    );

    expect(messages).toHaveLength(0);
  });
});
