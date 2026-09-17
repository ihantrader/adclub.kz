const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const eslintConfigPrettier = require("eslint-config-prettier");
const noRelativePackageImport = require("./rules/no-relative-package-import.js");
const noModuleInternalsImport = require("./rules/no-module-internals-import.js");

/**
 * Shared base flat config. Applies to every workspace package/app.
 * Enforces the package-boundary rule from ARCHITECTURE 4: a package's
 * source code may only import another `@adclub/*` package through its
 * public entry point, never a subpath into its internals — whether written
 * as an aliased subpath (`@adclub/domain/x`, caught by `no-restricted-imports`
 * below) or as a relative path reaching into another package's `src`
 * (`../../domain/src/x`, caught by `no-relative-package-import`).
 */
const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".turbo/**", "**/eslint.config.js"],
  },
  {
    files: ["**/src/**/*.{ts,tsx}"],
    plugins: {
      local: {
        rules: {
          "no-relative-package-import": noRelativePackageImport,
          // Enabled only in apps/api/eslint.config.js (ARCHITECTURE 4.2 I12):
          // the only app with the src/modules/<name> layout this rule checks.
          "no-module-internals-import": noModuleInternalsImport,
        },
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@adclub/*/*"],
              message:
                "Import the package's public entry point (e.g. '@adclub/domain'), not an internal subpath.",
            },
          ],
        },
      ],
      "local/no-relative-package-import": "error",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  eslintConfigPrettier,
);

module.exports = base;
