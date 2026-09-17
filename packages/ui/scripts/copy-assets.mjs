// Copies the non-TypeScript sources (CSS, fonts and their license) next to
// the compiled JavaScript: `dist/index.js` imports `./styles/*.css`, and the
// CSS refers to `../fonts/*.woff2`, which Vite bundles into each web app.
//
//   node scripts/copy-assets.mjs --clean  remove dist (before `tsc`: no stale modules)
//   node scripts/copy-assets.mjs          copy once (after `tsc`)
//   node scripts/copy-assets.mjs --watch  copy, then run `tsc --watch` and re-copy on change
import { spawn } from "node:child_process";
import { cpSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const folders = ["styles", "fonts"];

function copy() {
  for (const folder of folders) {
    cpSync(join(root, "src", folder), join(root, "dist", folder), {
      recursive: true,
      filter: (source) => !/\.(ts|tsx)$/.test(source),
    });
  }
}

if (process.argv.includes("--clean")) {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  process.exit(0);
}

copy();

if (process.argv.includes("--watch")) {
  for (const folder of folders) {
    watch(join(root, "src", folder), () => copy());
  }
  const tsc = spawn(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc"),
      "-p",
      "tsconfig.build.json",
      "--watch",
      "--preserveWatchOutput",
    ],
    { cwd: root, stdio: "inherit" },
  );
  tsc.on("exit", (code) => process.exit(code ?? 0));
}
