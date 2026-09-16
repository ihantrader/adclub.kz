import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    // Starting a real Postgres container (Testcontainers) is slow the
    // first time an image needs pulling.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
