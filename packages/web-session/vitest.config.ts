import { defineConfig } from "vitest/config";

// The session rules are tested as they are, without a DOM (`session-core.ts`).
export default defineConfig({
  test: {
    environment: "node",
  },
});
