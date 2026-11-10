// What the generators of the synthetic photo sets share (TASK-058): the
// drawing helpers, the control strip the test AI provider reads, the
// "photographed" variants (glare, tilt, blur, low resolution, a thumb over
// part of the picture) and the writing of a set with `--check`.
//
// Everything drawn is made up and marked «ОБРАЗЕЦ · SAMPLE». The strip is
// the one of `scripts/vehicle-document-samples.mjs` and
// `apps/api/src/modules/ai/test-vehicle-documents.ts` (same geometry): a
// start pair, eight bits of the sample's code and a closing cell in the top
// left corner.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps", "api", "package.json"));
export const sharp = require("sharp");

/** The strip, as a share of the picture's width (the decoder uses the same). */
const MARKER = { margin: 0.015, cell: 0.03 };

export function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function text(
  x,
  y,
  value,
  {
    size = 20,
    weight = "normal",
    fill = "#1d2a36",
    font = "Arial",
    anchor = "start",
    spacing = 0,
    opacity = 1,
  } = {},
) {
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}" opacity="${opacity}">${esc(value)}</text>`;
}

export function svgOf(width, height, parts) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`,
  );
}

export function watermark(width, height, color = "#b0262c") {
  const cx = width / 2;
  const cy = height / 2;
  return `<g transform="rotate(-18 ${cx} ${cy})" opacity="0.16">${text(cx, cy, "ОБРАЗЕЦ · SAMPLE", { size: Math.round(width / 12), weight: "bold", fill: color, anchor: "middle" })}${text(cx, cy + Math.round(width / 24), "ДАННЫЕ ВЫДУМАНЫ", { size: Math.round(width / 42), weight: "bold", fill: color, anchor: "middle" })}</g>`;
}

/** The strip of the sample's code, drawn on the photo itself. */
function marker(code, width) {
  const cell = Math.round(MARKER.cell * width);
  const left = Math.round(MARKER.margin * width);
  const top = left;
  const bits = [1, 0, ...Array.from({ length: 8 }, (_, i) => (code >> (7 - i)) & 1), 1];
  const pad = Math.round(cell * 0.4);
  return [
    `<rect x="${left - pad}" y="${top - pad}" width="${cell * 11 + pad * 2}" height="${cell + pad * 2}" fill="#ffffff"/>`,
    ...bits.map(
      (bit, index) =>
        `<rect x="${left + index * cell}" y="${top}" width="${cell}" height="${cell}" fill="${bit ? "#000000" : "#ffffff"}"/>`,
    ),
  ].join("");
}

/**
 * A drawn picture (`{ width, height, svg }`) "photographed" on a background:
 * scaled into the frame, the variant applied, the strip of `code` on top,
 * written as JPEG.
 */
export async function photograph(drawn, { variant, code, canvas, background, thumb }) {
  const scale = Math.min(
    (canvas.width * 0.86) / drawn.width,
    (canvas.height * 0.82) / drawn.height,
  );
  const width = Math.round(drawn.width * scale);
  const height = Math.round(drawn.height * scale);
  let layer = await sharp(drawn.svg).resize(width, height).png().toBuffer();
  if (variant === "glare") {
    const glare = svgOf(width, height, [
      `<defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0.4"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>`,
      `<ellipse cx="${width * 0.3}" cy="${height * 0.28}" rx="${width * 0.22}" ry="${height * 0.18}" fill="url(#g)"/>`,
    ]);
    layer = await sharp(layer)
      .composite([{ input: glare }])
      .png()
      .toBuffer();
  }
  if (variant === "occluded" || variant === "occluded_digits") {
    // A thumb: over a corner of the picture, or over the very digits.
    const [cx, cy] = thumb ?? (variant === "occluded" ? [0.12, 0.85] : [0.5, 0.72]);
    const finger = svgOf(width, height, [
      `<ellipse cx="${width * cx}" cy="${height * cy}" rx="${width * 0.16}" ry="${height * 0.12}" fill="#d9a483"/>`,
      `<ellipse cx="${width * (cx + 0.04)}" cy="${height * (cy - 0.02)}" rx="${width * 0.06}" ry="${height * 0.05}" fill="#e7b99c"/>`,
    ]);
    layer = await sharp(layer)
      .composite([{ input: finger }])
      .png()
      .toBuffer();
  }
  if (variant === "blur") {
    layer = await sharp(layer).blur(4.5).png().toBuffer();
  }
  if (variant === "tilt") {
    layer = await sharp(layer)
      .rotate(-8, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }
  const meta = await sharp(layer).metadata();
  const left = Math.round((canvas.width - meta.width) / 2);
  const top = Math.round((canvas.height - meta.height) / 2 + canvas.height * 0.03);
  let buffer = await sharp(background)
    .composite([
      { input: layer, left, top },
      { input: svgOf(canvas.width, canvas.height, [marker(code, canvas.width)]) },
    ])
    .png()
    .toBuffer();
  if (variant === "lowres") {
    buffer = await sharp(buffer).resize({ width: 560 }).png().toBuffer();
  }
  return sharp(buffer).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

/**
 * Writes a set: the pictures and `samples.json`. With `--check` nothing is
 * written: the expected values must equal `samples.json` and every picture
 * must be there (the pictures themselves depend on the fonts of the machine,
 * so their bytes are not compared — the unit test of the API reads their
 * strips).
 */
export async function writeSet({ directory, note, samples, draw }) {
  const check = process.argv.includes("--check");
  const pictures = join(directory, "samples");
  const entries = samples.map((entry) => ({ ...entry, file: `samples/${entry.id}.jpg` }));
  const json = `${JSON.stringify({ version: 1, note, samples: entries }, null, 2)}\n`;
  if (check) {
    const problems = [];
    const path = join(directory, "samples.json");
    if (!existsSync(path) || readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== json) {
      problems.push(`${path} is not what the generator makes`);
    }
    const wanted = new Set(entries.map((entry) => `${entry.id}.jpg`));
    const present = existsSync(pictures) ? new Set(readdirSync(pictures)) : new Set();
    for (const name of wanted) if (!present.has(name)) problems.push(`missing samples/${name}`);
    for (const name of present) if (!wanted.has(name)) problems.push(`unexpected samples/${name}`);
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      console.error("Run the generator without --check and commit the result.");
      process.exit(1);
    }
    console.log(`${entries.length} samples in ${directory} are up to date`);
    return;
  }
  rmSync(pictures, { recursive: true, force: true });
  mkdirSync(pictures, { recursive: true });
  for (const sample of samples) {
    const bytes = await draw(sample);
    writeFileSync(join(pictures, `${sample.id}.jpg`), bytes);
    console.log(`samples/${sample.id}.jpg ${bytes.length} bytes`);
  }
  writeFileSync(join(directory, "samples.json"), json);
  console.log(`${samples.length} samples written to ${directory}`);
}
