import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
  },
  // Workspace packages ship CommonJS (see ARCHITECTURE 4); esbuild's dep
  // pre-bundler interops CJS -> ESM correctly, but only for deps it scans.
  // Linked workspace packages aren't scanned automatically, so list them.
  optimizeDeps: {
    include: ["@adclub/ui", "@adclub/i18n"],
  },
});
