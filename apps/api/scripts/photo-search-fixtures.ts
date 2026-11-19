import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

/**
 * The pictures of the test image search (TASK-068): `apps/api/fixtures/
 * photo-search`. Made-up drawings with the watermark «ОБРАЗЕЦ» — no picture
 * of a real site. `pnpm --filter @adclub/api photo-search:samples` writes
 * them again; `--check` compares with what is in the repository.
 *
 * What they are for (`fixtures.json` says where each one «is»):
 * - `geely-front-pads.jpg` — the manufacturer's site;
 * - `shop-pads.jpg` and `shop-pads-small.jpg` — one picture on two shops,
 *   the second smaller and compressed harder (a near duplicate → `multi_store`);
 * - `lonely-shop.jpg` — on one shop only (dropped: `other_domain`);
 * - `trw-pads.png` — an official catalogue;
 * - `shell-oil.webp` — the manufacturer's site of an oil;
 * - `broken.jpg`, `not-an-image.jpg`, `vector.svg` — files the checks refuse.
 */

const directory = resolve(__dirname, "..", "fixtures", "photo-search");
const check = process.argv.includes("--check");

function drawing(options: {
  width: number;
  height: number;
  background: string;
  shapes: string;
  label: string;
}): Buffer {
  const { width, height } = options;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 640 480">` +
      `<rect width="640" height="480" fill="${options.background}"/>` +
      options.shapes +
      `<text x="320" y="450" font-family="Arial, sans-serif" font-size="28" fill="#333" text-anchor="middle">${options.label}</text>` +
      `<text x="320" y="260" font-family="Arial, sans-serif" font-size="72" fill="#000" fill-opacity="0.12" text-anchor="middle" transform="rotate(-20 320 240)">ОБРАЗЕЦ</text>` +
      `</svg>`,
  );
}

const pads = (color: string) =>
  `<rect x="90" y="140" width="200" height="120" rx="40" fill="${color}"/>` +
  `<rect x="350" y="140" width="200" height="120" rx="40" fill="${color}"/>` +
  `<rect x="110" y="270" width="160" height="30" fill="#555"/>` +
  `<rect x="370" y="270" width="160" height="30" fill="#555"/>`;

async function render(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  files.set(
    "geely-front-pads.jpg",
    await sharp(
      drawing({
        width: 800,
        height: 600,
        background: "#e8eef7",
        shapes: pads("#2b5fa8") + `<circle cx="320" cy="90" r="50" fill="#1d3f70"/>`,
        label: "Geely 04465-0K090",
      }),
    )
      .jpeg({ quality: 88 })
      .toBuffer(),
  );
  const shop = drawing({
    width: 640,
    height: 480,
    background: "#fbf3e4",
    shapes:
      `<polygon points="60,380 320,60 580,380" fill="#c0392b"/>` +
      `<rect x="200" y="250" width="240" height="90" fill="#f1c40f"/>`,
    label: "04465-0K090",
  });
  files.set("shop-pads.jpg", await sharp(shop).jpeg({ quality: 90 }).toBuffer());
  files.set(
    "shop-pads-small.jpg",
    await sharp(shop).resize(480, 360).jpeg({ quality: 60 }).toBuffer(),
  );
  files.set(
    "lonely-shop.jpg",
    await sharp(
      drawing({
        width: 640,
        height: 480,
        background: "#eafaf1",
        shapes: `<ellipse cx="320" cy="220" rx="250" ry="120" fill="#16a085"/>`,
        label: "Колодки",
      }),
    )
      .jpeg({ quality: 85 })
      .toBuffer(),
  );
  files.set(
    "trw-pads.png",
    await sharp(
      drawing({
        width: 600,
        height: 450,
        background: "#ffffff",
        shapes: pads("#7f8c8d") + `<rect x="250" y="40" width="140" height="60" fill="#e67e22"/>`,
        label: "TRW GDB3534",
      }),
    )
      .png()
      .toBuffer(),
  );
  files.set(
    "shell-oil.webp",
    await sharp(
      drawing({
        width: 500,
        height: 500,
        background: "#fff8d6",
        shapes:
          `<rect x="220" y="80" width="200" height="300" rx="30" fill="#f4c20d"/>` +
          `<rect x="280" y="40" width="80" height="50" fill="#d62d20"/>`,
        label: "Shell Helix",
      }),
    )
      .webp({ quality: 85 })
      .toBuffer(),
  );
  const whole = files.get("lonely-shop.jpg")!;
  files.set("broken.jpg", whole.subarray(0, Math.floor(whole.byteLength / 3)));
  files.set(
    "not-an-image.jpg",
    Buffer.from("<!doctype html><html><body>Страница магазина, а не картинка</body></html>\n"),
  );
  files.set(
    "vector.svg",
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n`,
    ),
  );
  return files;
}

async function main(): Promise<void> {
  const files = await render();
  mkdirSync(directory, { recursive: true });
  const differ: string[] = [];
  for (const [name, bytes] of files) {
    const path = join(directory, name);
    if (check) {
      let current: Buffer | null;
      try {
        current = readFileSync(path);
      } catch {
        current = null;
      }
      if (!current || !current.equals(bytes)) differ.push(name);
    } else {
      writeFileSync(path, bytes);
    }
  }
  if (check && differ.length > 0) {
    console.error(`Photo search fixtures differ: ${differ.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(check ? "Photo search fixtures are up to date" : `Wrote ${String(files.size)} files`);
}

void main();
