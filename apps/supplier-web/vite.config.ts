import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
  },
  // Sent to the API as `X-Client: supplier-web/<version>` (ARCHITECTURE 7.4).
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  // Workspace packages ship CommonJS (see ARCHITECTURE 4); esbuild's dep
  // pre-bundler interops CJS -> ESM correctly, but only for deps it scans.
  // Linked workspace packages aren't scanned automatically, so list them.
  optimizeDeps: {
    include: ["@adclub/api-client", "@adclub/ui", "@adclub/i18n"],
  },
});
