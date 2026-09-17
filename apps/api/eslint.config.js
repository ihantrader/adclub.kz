const base = require("@adclub/config/eslint/node.js");

/**
 * Adds the ARCHITECTURE 4 module-boundary rule on top of the shared node
 * config: a domain module under `src/modules/<name>` may only be reached
 * through its `index.ts`, never a path into its internals. Scoped to
 * `apps/api` because that's the only app with this `src/modules` layout.
 * The rule itself (and the `local` plugin registration) lives in
 * `@adclub/config/eslint/base.js`, shared with `no-relative-package-import`
 * — a second `plugins.local` here would conflict with it (ESLint refuses to
 * redefine an already-registered plugin for overlapping files).
 */
module.exports = [
  ...base,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "local/no-module-internals-import": "error",
    },
  },
];
