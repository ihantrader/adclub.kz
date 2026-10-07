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
    port: 5174,
  },
  // Sent to the API as `X-Client: admin-web/<version>` (ARCHITECTURE 7.4).
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  // Workspace packages ship CommonJS (see ARCHITECTURE 4); esbuild's dep
  // pre-bundler interops CJS -> ESM correctly, but only for deps it scans.
  // Linked workspace packages aren't scanned automatically, so list them.
  // `@adclub/ui` is ESM with CSS and fonts and is served as is (ARCHITECTURE
  // 4.10); its icons are path data of `@adclub/ui-core` (4.43).
  optimizeDeps: {
    include: [
      "@adclub/api-client",
      "@adclub/contracts",
      "@adclub/domain",
      "@adclub/i18n",
      "@adclub/ui-core",
      "@adclub/web-session",
    ],
  },
});
