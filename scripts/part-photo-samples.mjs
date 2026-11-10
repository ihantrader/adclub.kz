// The synthetic sample set for reading the article off a photo of a part or
// its box (TASK-058, D-058): `pnpm part-photo:samples` draws every sample of
// `ai-eval/part-photo/` and writes `samples.json`; `--check` only checks
// that `samples.json` and the list of pictures are up to date.
//
// Everything is made up and drawn: labels and boxes of several made-up
// layouts with the articles of the development catalog (`04465-0K090`,
// `GDB3534`, …) written with a dash, with spaces or without, next to a
// barcode, a batch number and a date; a label with two articles (the part's
// own and the original it replaces); labels without any article; a picture
// that is not a part at all. The brand names stand for the brands of the
// development catalog; the layouts copy no real packaging. Real photos are
// never put in the repository.
//
// Usage: node scripts/part-photo-samples.mjs [--check]
import { join } from "node:path";
import { photograph, root, svgOf, text, watermark, writeSet } from "./photo-sample-kit.mjs";

const OUT = join(root, "ai-eval", "part-photo");
const CANVAS = { width: 1600, height: 1150 };

function normalize(article) {
  return article.toUpperCase().replace(/[^A-Z0-9Ѐ-ӿ]+/g, "");
}

const LAYOUTS = {
  oem: { band: "#1d3f73", paper: "#f4f6f9", ink: "#13243f", font: "Arial" },
  aftermarket: { band: "#e2a200", paper: "#fffdf3", ink: "#1b1b1b", font: "Arial" },
  dark: { band: "#c21f2a", paper: "#1f2226", ink: "#f2f2f2", font: "Arial" },
  plain: { band: "#6b6f75", paper: "#ffffff", ink: "#222222", font: "Courier New" },
};

/**
 * The samples. `printed` — the articles as written on the label (the first
 * is the part's own); `extra` — other numbers on it (barcode, batch, date)
 * that are not articles; `expected.articles` — normalized, likeliest first.
 */
const SAMPLES = [
  {
    id: "geely-box-clean",
    code: 1,
    layout: "oem",
    brand: "GEELY",
    name: "Колодки тормозные передние",
    printed: ["04465-0K090"],
    variant: "clean",
  },
  {
    id: "geely-box-glare",
    code: 2,
    layout: "oem",
    brand: "GEELY",
    name: "Колодки тормозные передние",
    printed: ["04465-0K090"],
    variant: "glare",
  },
  {
    id: "geely-box-tilt",
    code: 3,
    layout: "oem",
    brand: "GEELY",
    name: "Колодки тормозные передние",
    printed: ["04465-0K090"],
    variant: "tilt",
  },
  {
    id: "trw-label-clean",
    code: 4,
    layout: "aftermarket",
    brand: "TRW",
    name: "Brake pad set",
    printed: ["GDB3534"],
    variant: "clean",
  },
  {
    id: "trw-label-two-articles",
    code: 5,
    layout: "aftermarket",
    brand: "TRW",
    name: "Brake pad set",
    printed: ["GDB3534"],
    replaces: "04465-0K090",
    variant: "clean",
  },
  {
    id: "geely-sticker-no-dash",
    code: 6,
    layout: "plain",
    brand: "GEELY",
    name: "PAD KIT FR",
    printed: ["044650K090"],
    variant: "clean",
  },
  {
    id: "geely-rear-zeros",
    code: 7,
    layout: "oem",
    brand: "GEELY",
    name: "Колодки тормозные задние",
    printed: ["4050068800"],
    variant: "clean",
  },
  {
    id: "febi-barcode-batch-date",
    code: 8,
    layout: "aftermarket",
    brand: "FEBI",
    name: "Фильтр масляный",
    printed: ["FEB35074"],
    barcode: "4027816350743",
    lot: "LOT 2405-117",
    date: "03/2025",
    variant: "clean",
  },
  {
    id: "geely-filter-barcode",
    code: 9,
    layout: "oem",
    brand: "GEELY",
    name: "Фильтр воздушный",
    printed: ["11818-0249"],
    barcode: "6901234502497",
    variant: "clean",
  },
  {
    id: "geely-sensor-lowres",
    code: 10,
    layout: "oem",
    brand: "GEELY",
    name: "Датчик",
    printed: ["64642-0212"],
    variant: "lowres",
  },
  {
    id: "mann-filter-clean",
    code: 11,
    layout: "dark",
    brand: "MANN",
    name: "Oil filter",
    printed: ["MAN67527"],
    barcode: "4011558000059",
    variant: "clean",
  },
  {
    id: "sachs-shock-glare",
    code: 12,
    layout: "aftermarket",
    brand: "SACHS",
    name: "Амортизатор",
    printed: ["SAC28522"],
    date: "11/2024",
    variant: "glare",
  },
  {
    id: "ngk-plug-dark",
    code: 13,
    layout: "dark",
    brand: "NGK",
    name: "Spark plug",
    printed: ["NGK26258"],
    variant: "clean",
  },
  {
    id: "trw-label-tilt",
    code: 14,
    layout: "aftermarket",
    brand: "TRW",
    name: "Brake pad set",
    printed: ["GDB3534"],
    variant: "tilt",
  },
  {
    id: "geely-box-spaces",
    code: 15,
    layout: "plain",
    brand: "GEELY",
    name: "Колодки",
    printed: ["04465 0K090"],
    variant: "clean",
  },
  {
    id: "geely-box-occluded",
    code: 16,
    layout: "oem",
    brand: "GEELY",
    name: "Колодки тормозные передние",
    printed: ["04465-0K090"],
    variant: "occluded_digits",
    readable: false,
  },
  {
    id: "trw-label-blur",
    code: 17,
    layout: "aftermarket",
    brand: "TRW",
    name: "Brake pad set",
    printed: ["GDB3534"],
    variant: "blur",
    readable: false,
  },
  {
    id: "mann-filter-lowres",
    code: 18,
    layout: "dark",
    brand: "MANN",
    name: "Oil filter",
    printed: ["MAN67527"],
    variant: "lowres",
  },
  {
    id: "febi-label-tilt",
    code: 19,
    layout: "aftermarket",
    brand: "FEBI",
    name: "Фильтр масляный",
    printed: ["FEB35074"],
    barcode: "4027816350743",
    variant: "tilt",
  },
  {
    id: "no-article-oil-can",
    code: 30,
    layout: "dark",
    brand: "SHELL",
    name: "Моторное масло 5W-30 · 4 л",
    printed: [],
    barcode: "5011987912342",
    lot: "LOT 2311-08",
    variant: "clean",
  },
  {
    id: "no-article-brand-box",
    code: 31,
    layout: "oem",
    brand: "GEELY",
    name: "Genuine parts · Made in China",
    printed: [],
    variant: "clean",
  },
  {
    id: "no-article-only-barcode",
    code: 32,
    layout: "plain",
    brand: "",
    name: "Упаковка",
    printed: [],
    barcode: "4600000123455",
    date: "05/2025",
    variant: "tilt",
  },
  { id: "not-a-part", code: 33, other: "landscape", printed: [], variant: "clean" },
];

// ------------------------------------------------------------- drawing

function barcode(x, y, digits) {
  const bars = [];
  let cursor = x;
  for (let i = 0; i < 64; i += 1) {
    const wide = (Number(digits[i % digits.length]) + i) % 3 === 0;
    const width = wide ? 6 : 3;
    if (i % 2 === 0)
      bars.push(`<rect x="${cursor}" y="${y}" width="${width}" height="120" fill="#000"/>`);
    cursor += width + 2;
  }
  bars.push(
    text(x + (cursor - x) / 2, y + 160, digits, {
      size: 32,
      anchor: "middle",
      font: "Courier New",
      fill: "#000",
    }),
  );
  return bars.join("");
}

function label(sample) {
  const style = LAYOUTS[sample.layout];
  const w = 1400;
  const h = 860;
  const parts = [
    `<rect width="${w}" height="${h}" rx="18" fill="${style.paper}" stroke="#9aa0a6" stroke-width="4"/>`,
    `<rect width="${w}" height="170" rx="18" fill="${style.band}"/><rect y="120" width="${w}" height="50" fill="${style.band}"/>`,
  ];
  if (sample.brand) {
    parts.push(
      text(60, 118, sample.brand, {
        size: 92,
        weight: "bold",
        fill: "#ffffff",
        font: "Arial Black",
      }),
    );
  }
  parts.push(text(60, 260, sample.name, { size: 46, fill: style.ink, font: style.font }));
  const [own] = sample.printed;
  if (own) {
    parts.push(
      text(60, 360, "Art. No / Артикул", {
        size: 30,
        fill: style.ink,
        font: "Arial",
        opacity: 0.75,
      }),
      text(60, 450, own, {
        size: 96,
        weight: "bold",
        fill: style.ink,
        font: style.font,
        spacing: 2,
      }),
    );
  }
  if (sample.replaces) {
    parts.push(
      text(60, 530, `Заменяет / Replaces OE: ${sample.replaces}`, {
        size: 38,
        fill: style.ink,
        font: style.font,
      }),
    );
  }
  if (sample.lot)
    parts.push(text(60, 610, sample.lot, { size: 34, fill: style.ink, font: "Courier New" }));
  if (sample.date)
    parts.push(
      text(60, 660, `Дата / Date: ${sample.date}`, {
        size: 34,
        fill: style.ink,
        font: "Courier New",
      }),
    );
  if (sample.barcode) {
    parts.push(
      `<rect x="860" y="560" width="500" height="250" fill="#ffffff"/>`,
      barcode(880, 580, sample.barcode),
    );
  }
  parts.push(
    text(60, 800, "Qty 1 SET", { size: 30, fill: style.ink, font: "Arial", opacity: 0.7 }),
  );
  parts.push(watermark(w, h));
  return { width: w, height: h, svg: svgOf(w, h, parts) };
}

function landscape() {
  const w = 1400;
  const h = 860;
  return {
    width: w,
    height: h,
    svg: svgOf(w, h, [
      `<rect width="${w}" height="${h}" fill="#9cc7e6"/>`,
      `<path d="M0 560 L300 300 L520 520 L800 240 L1100 540 L1400 380 L1400 860 L0 860 Z" fill="#5d7f5b"/>`,
      `<circle cx="1180" cy="160" r="80" fill="#ffe08a"/>`,
      watermark(w, h),
    ]),
  };
}

function background() {
  const { width, height } = CANVAS;
  const parts = [
    `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9c8b77"/><stop offset="1" stop-color="#6b5c4b"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#t)"/>`,
  ];
  for (let i = 0; i < 30; i += 1) {
    const y = (height / 30) * i + ((i * 29) % 13);
    parts.push(
      `<path d="M0 ${y} C ${width / 3} ${y + 10} ${(2 * width) / 3} ${y - 10} ${width} ${y}" stroke="#4a3d30" stroke-width="2" fill="none" opacity="0.2"/>`,
    );
  }
  return svgOf(width, height, parts);
}

// --------------------------------------------------------------- run

function entryOf(sample) {
  const articles = [...sample.printed, ...(sample.replaces ? [sample.replaces] : [])].map(
    normalize,
  );
  const readable = sample.readable ?? true;
  const hasArticle = articles.length > 0;
  return {
    id: sample.id,
    code: sample.code,
    variant: sample.variant,
    layout: sample.other ?? sample.layout,
    // An article a person could read: the thresholds of D-058 are counted on these.
    readable: readable && hasArticle,
    ...(readable
      ? {}
      : { acceptKinds: ["article_found", "no_article", "unreadable"], hiddenArticle: articles[0] }),
    expected: {
      kind: sample.other ? "unreadable" : hasArticle ? "article_found" : "no_article",
      articles: readable ? articles : [],
      brand: sample.brand || null,
      // Numbers on the label that are not an article: answering one is a false article.
      notArticles: [sample.barcode, sample.lot, sample.date].filter(Boolean).map(normalize),
    },
  };
}

const byId = new Map(SAMPLES.map((sample) => [sample.id, sample]));
await writeSet({
  directory: OUT,
  note: "Synthetic samples with made-up data (TASK-058). Generated by scripts/part-photo-samples.mjs — do not edit by hand.",
  samples: SAMPLES.map(entryOf),
  draw: (entry) => {
    const sample = byId.get(entry.id);
    return photograph(sample.other ? landscape() : label(sample), {
      variant: entry.variant,
      code: entry.code,
      canvas: CANVAS,
      background: background(),
      // The thumb of `occluded_digits` lies over the article itself.
      thumb: [0.28, 0.5],
    });
  },
});
