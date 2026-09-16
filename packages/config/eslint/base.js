const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const eslintConfigPrettier = require("eslint-config-prettier");

/**
 * Shared base flat config. Applies to every workspace package/app.
 * Enforces the package-boundary rule from ARCHITECTURE 4: a package's
 * source code may only import another `@adclub/*` package through its
 * public entry point, never a subpath into its internals.
 */
const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".turbo/**", "**/eslint.config.js"],
  },
  {
    files: ["**/src/**/*.{ts,tsx}"],
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
