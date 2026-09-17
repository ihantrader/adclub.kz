import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    // Captures (and silences) the whole process output of every file and
    // fails the file if a remembered secret shows up in it.
    setupFiles: ["src/testing/output-capture.ts"],
    // Starting a real Postgres container (Testcontainers) is slow the
    // first time an image needs pulling.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
