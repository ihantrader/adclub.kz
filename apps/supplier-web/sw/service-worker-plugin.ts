import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** Files of the build the shell needs offline; source maps, the page and the worker itself are not. */
export function shellFiles(fileNames: readonly string[]): string[] {
  return [
    ...new Set(
      fileNames
        .filter((name) => !name.endsWith(".map") && name !== "sw.js" && name !== "index.html")
        .filter((name) => /\.(js|css|woff2|png|svg|webmanifest|ico)$/.test(name))
        .map((name) => `/${name.replace(/^\/+/, "")}`),
    ),
  ].sort();
}

/**
 * The worker for one build: its version is a hash of what it keeps, so a
 * new build is a new worker (the browser compares /sw.js byte by byte),
 * and an unchanged build keeps the old one.
 */
export function serviceWorkerSource(
  template: string,
  files: readonly string[],
  page: string,
): string {
  const version = createHash("sha256")
    .update(JSON.stringify(files))
    .update(page)
    .digest("hex")
    .slice(0, 16);
  if (!template.includes('"__VERSION__"') || !template.includes('["__FILES__"]')) {
    throw new Error("The service worker template has lost its placeholders");
  }
  return template
    .replace('"__VERSION__"', JSON.stringify(version))
    .replace('["__FILES__"]', JSON.stringify(files));
}

/**
 * Writes /sw.js next to the production build once it is on disk (TASK-031
 * requirement 4): the files of the bundle and the public files (icons,
 * manifest) the shell needs offline.
 */
export function cabinetServiceWorker(options: {
  template: URL;
  publicFiles: readonly string[];
}): Plugin {
  return {
    name: "adclub-cabinet-service-worker",
    apply: "build",
    enforce: "post",
    writeBundle(output, bundle) {
      const outDir = output.dir ?? "dist";
      const page = readFileSync(join(outDir, "index.html"), "utf8");
      const files = shellFiles([...Object.keys(bundle), ...options.publicFiles]);
      writeFileSync(
        join(outDir, "sw.js"),
        serviceWorkerSource(readFileSync(options.template, "utf8"), files, page),
      );
    },
  };
}
