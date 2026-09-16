import { defineConfig } from "vitest/config";

// Unit tests cover plain TypeScript logic only (no React Native runtime):
// anything importing `react-native` stays out of `*.test.ts` files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
