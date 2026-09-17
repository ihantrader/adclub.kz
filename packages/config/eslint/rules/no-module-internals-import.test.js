import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import rule from "./no-module-internals-import.js";

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
        plugins: { local: { rules: { "no-module-internals-import": rule } } },
        rules: { "local/no-module-internals-import": "error" },
      },
    ],
    filename,
  );
}

describe("no-module-internals-import", () => {
  it("flags a path into another module's internals", () => {
    const messages = lint(
      "apps/api/src/app.module.ts",
      'import { SessionService } from "./modules/identity/session/session.service";',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe("deepImport");
  });

  it("allows importing a module through its index", () => {
    const messages = lint(
      "apps/api/src/app.module.ts",
      'import { IdentityModule } from "./modules/identity";',
    );

    expect(messages).toHaveLength(0);
  });

  it("allows a module importing its own internals", () => {
    const messages = lint(
      "apps/api/src/modules/identity/session/session.controller.ts",
      'import { SessionService } from "./session.service";',
    );

    expect(messages).toHaveLength(0);
  });

  it("allows one submodule reaching into a sibling submodule's internals within the same module (identity/session and identity/account are not separate modules)", () => {
    const messages = lint(
      "apps/api/src/modules/identity/account/account.service.ts",
      'import { SessionService } from "../session/session.service";',
    );

    expect(messages).toHaveLength(0);
  });

  it("flags a different module reaching into identity's internals", () => {
    const messages = lint(
      "apps/api/src/modules/catalog/catalog.service.ts",
      'import { SessionService } from "../identity/session/session.service";',
    );

    expect(messages).toHaveLength(1);
  });
});
