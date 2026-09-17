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
  {
    // ARCHITECTURE 15.3: error monitoring is reached through the
    // observability module only — nothing else builds or sends an event, so
    // everything that leaves the process goes through the one sanitizer.
    // The pure files the configuration and the logger need (the DSN parser,
    // the sanitizer itself, the metric primitives and the two injectables)
    // stay reachable; the client that posts events does not.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/observability/**"],
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
            {
              group: [
                "**/observability/*",
                "!**/observability/index",
                "!**/observability/sanitizer",
                "!**/observability/monitoring-dsn",
                "!**/observability/metrics-registry",
                "!**/observability/metrics.service",
                "!**/observability/error-reporter.service",
              ],
              message:
                "Error monitoring is used through the observability module (ARCHITECTURE 15.3): import '../observability', not its internals.",
            },
          ],
        },
      ],
    },
  },
];
