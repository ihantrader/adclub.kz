import { defineConfig } from "vitest/config";

// Unit tests cover the admin panel's plain logic (addresses, forms, words);
// screens are checked in a real browser (TASK-034 report).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
