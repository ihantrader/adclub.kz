import { defineConfig } from "vitest/config";

// Unit tests cover the cabinet's plain logic (session, routes, forms, PWA
// detection); screens are checked in a real browser (TASK-031 report).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "sw/**/*.test.ts"],
  },
});
