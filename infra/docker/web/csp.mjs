// The security headers of a web client image (TASK-055, ARCHITECTURE 4.82),
// written at image build time from the very `index.html` the image serves:
//
//   node infra/docker/web/csp.mjs <dist dir> <api url> <supplier-web|admin-web> <out file>
//
// Content-Security-Policy without 'unsafe-inline' for scripts: every inline
// <script> of index.html (the cabinet's theme script, which must run before
// the first paint) is allowed by its SHA-256 hash, so changing the script
// changes the hash in the same build and nothing else can run inline.
// Styles keep 'unsafe-inline' (React sets `style` attributes); connections go
// only to this origin and the API the build was made for; images may come
// from any HTTPS address (signed links of the storage, the source addresses
// of catalog photos — photo_display_mode `link`). The output is a Caddyfile
// snippet the image's Caddyfile imports.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dist, apiUrl, app, out] = process.argv.slice(2);
if (!dist || !apiUrl || !app || !out) {
  console.error("usage: csp.mjs <dist dir> <api url> <supplier-web|admin-web> <out file>");
  process.exit(2);
}
if (app !== "supplier-web" && app !== "admin-web") {
  console.error(`unknown app "${app}"`);
  process.exit(2);
}

const apiOrigin = new URL(apiUrl).origin;
const html = readFileSync(join(dist, "index.html"), "utf8");

/** Inline scripts: a <script> without `src`, its text exactly as the browser hashes it. */
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);
const hashes = inlineScripts.map(
  (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`,
);

const policy = [
  "default-src 'self'",
  ["script-src 'self'", ...hashes].join(" "),
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' ${apiOrigin}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The cabinet scans QR codes with the camera (S-SCAN-01); the admin panel uses
// no device at all.
const permissions =
  app === "supplier-web"
    ? "camera=(self), microphone=(), geolocation=(), payment=(), usb=()"
    : "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

writeFileSync(
  out,
  [
    "# Written by infra/docker/web/csp.mjs at image build time — do not edit.",
    "header {",
    `\tContent-Security-Policy "${policy}"`,
    `\tPermissions-Policy "${permissions}"`,
    "}",
    "",
  ].join("\n"),
);
console.log(`csp: ${inlineScripts.length} inline script(s) hashed, connect-src ${apiOrigin}`);
