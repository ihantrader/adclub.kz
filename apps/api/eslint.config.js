const base = require("@adclub/config/eslint/node.js");
const noModuleInternalsImport = require("@adclub/config/eslint/rules/no-module-internals-import.js");

/**
 * Adds the ARCHITECTURE 4 module-boundary rule on top of the shared node
 * config: a domain module under `src/modules/<name>` may only be reached
 * through its `index.ts`, never a path into its internals. Scoped to
 * `apps/api` because that's the only app with this `src/modules` layout.
 */
module.exports = [
  ...base,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      local: {
        rules: {
          "no-module-internals-import": noModuleInternalsImport,
        },
      },
    },
    rules: {
      "local/no-module-internals-import": "error",
    },
  },
];
