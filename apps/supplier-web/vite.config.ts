import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cabinetServiceWorker } from "./sw/service-worker-plugin";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

/** Every file of `public/`, as the build copies it (the worker keeps them for offline use). */
function publicFiles(): string[] {
  const root = fileURLToPath(new URL("./public", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [relative(root, path)];
    });
  return walk(root).map((path) => path.split("\\").join("/"));
}

export default defineConfig({
  plugins: [
    react(),
    cabinetServiceWorker({
      template: new URL("./sw/service-worker.js", import.meta.url),
      publicFiles: publicFiles(),
    }),
  ],
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
