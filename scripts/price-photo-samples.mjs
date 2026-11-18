// The synthetic sample set for reading a photographed price list (TASK-064,
// D-058): `pnpm price-photo:samples` draws every sample of
// `ai-eval/price-photo/` and writes `samples.json`; `--check` only checks
// that `samples.json` and the list of pictures are up to date.
//
// Everything is made up and drawn: pages of a price list of a made-up
// company «ОБРАЗЕЦ» with the articles of the development catalog
// (`04465-0K090`, `GDB3534`, …) and a few items the catalog doesn't have, a
// list on two pages, the same list tilted, in small print, photographed off
// a monitor with glare, with a price corrected by hand and with a stain over
// a price (the model should say it is unsure), a letter that is no table,
// and a page too blurred to read. Real photos are never put in the
// repository.
//
// The rows of the pages are the very rows `apps/api/src/modules/ai/test-photos.ts`
// answers for them; `photo-fixtures.test.ts` checks the two agree.
//
// Usage: node scripts/price-photo-samples.mjs [--check]
import { join } from "node:path";
import { photograph, root, svgOf, text, watermark, writeSet } from "./photo-sample-kit.mjs";

const OUT = join(root, "ai-eval", "price-photo");
const CANVAS = { width: 1700, height: 2200 };

/** A row of a page: what is printed, and what the model should read off it. */
function row(article, brand, name, price, availability = "есть", lead = null, extra = {}) {
  return { article, brand, name, price, availability, lead, ...extra };
}

/** The list of a single page. */
const LIST = [
  row("04465-0K090", "GEELY", "Колодки тормозные передние", 18_500),
  row("GDB3534", "TRW", "Колодки тормозные передние TRW", 14_200),
  row("4050068800", "GEELY", "Колодки тормозные задние", 16_900, "под заказ", "3 дня"),
  row(null, "Shell", "Shell Helix HX8 5W-30, 4 л", 21_400),
  row(null, "Mobil", "Mobil Super 3000 5W-40, 4 л", 19_800, "нет"),
  row("ST-55120", "Стартвольт", "Свеча зажигания иридиевая", 3_450),
];

/** A list on two pages: the header is printed again on the second. */
const PAGE_1 = [
  row("04465-0K090", "GEELY", "Колодки тормозные передние", 18_500),
  row("GDB3534", "TRW", "Колодки тормозные передние TRW", 14_200),
  row("4050068800", "GEELY", "Колодки тормозные задние", 16_900, "под заказ", "3 дня"),
  row(null, "Shell", "Shell Helix HX8 5W-30, 4 л", 21_400),
];
const PAGE_2 = [
  // A coffee stain over this price: the model should say it is unsure of it.
  row(null, "Shell", "Shell Helix Ultra 0W-20, 1 л", 6_300, "есть", null, { stain: true }),
  row(null, "Mobil", "Mobil 1 ESP 5W-30", 24_000, "2 шт"),
  row("FM-301", "Фильтрон", "Фильтр масляный", 2_100),
];

/** Small print: two dozen rows of made-up parts, then the catalog's pads. */
const SMALL = [
  ...Array.from({ length: 22 }, (_, index) =>
    row(
      `KZ-${String(4100 + index * 7)}`,
      index % 3 === 0 ? "Стартвольт" : index % 3 === 1 ? "Фильтрон" : "Лузар",
      `Деталь образца № ${String(index + 1)}`,
      1_000 + index * 350,
      index % 5 === 4 ? "нет" : "есть",
    ),
  ),
  row("04465-0K090", "GEELY", "Колодки тормозные передние", 18_500),
  row("GDB3534", "TRW", "Колодки тормозные передние TRW", 14_200),
];

/** The list with a price corrected by hand: 16 900 crossed out, 17 500 written over. */
const CORRECTED = LIST.map((entry) =>
  entry.article === "4050068800" ? { ...entry, price: 17_500, corrected: 16_900 } : entry,
);

const SAMPLES = [
  { id: "list-clean", code: 1, kind: "list", rows: LIST, variant: "clean" },
  { id: "two-pages-1", code: 2, kind: "list", rows: PAGE_1, variant: "clean", page: [1, 2] },
  { id: "two-pages-2", code: 3, kind: "list", rows: PAGE_2, variant: "clean", page: [2, 2] },
  { id: "list-tilt", code: 4, kind: "list", rows: LIST, variant: "tilt" },
  { id: "list-small-font", code: 5, kind: "list", rows: SMALL, variant: "clean", small: true },
  { id: "screen-glare", code: 6, kind: "list", rows: LIST, variant: "glare", screen: true },
  { id: "pen-correction", code: 7, kind: "list", rows: CORRECTED, variant: "clean" },
  { id: "not-a-table", code: 8, kind: "letter", rows: [], variant: "clean" },
  { id: "unreadable-blur", code: 9, kind: "list", rows: LIST, variant: "blur", unreadable: true },
];

// --------------------------------------------------------------- drawing

const INK = "#1d2a36";
const PAGE = { width: 1240, height: 1754 };

function priceText(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function header(parts, sample) {
  parts.push(
    text(70, 110, "ТОО «Автозапчасти ОБРАЗЕЦ»", { size: 34, weight: "bold", fill: INK }),
    text(70, 152, "г. Алматы, ул. Примерная, 1 · тел. +7 701 000 03 61 (выдуманы)", {
      size: 20,
      fill: INK,
      opacity: 0.75,
    }),
    text(70, 210, "ПРАЙС-ЛИСТ на 18.11.2026, цены в тенге", {
      size: 28,
      weight: "bold",
      fill: INK,
    }),
  );
  if (sample.page) {
    parts.push(
      text(PAGE.width - 70, 110, `Стр. ${String(sample.page[0])} из ${String(sample.page[1])}`, {
        size: 22,
        fill: INK,
        anchor: "end",
      }),
    );
  }
}

const COLUMNS = [
  { title: "Артикул", x: 70, width: 200 },
  { title: "Бренд", x: 270, width: 150 },
  { title: "Наименование", x: 420, width: 400 },
  { title: "Цена, тг", x: 830, width: 130, align: "end" },
  { title: "Наличие", x: 980, width: 120 },
  { title: "Срок", x: 1105, width: 80 },
];

function table(parts, rows, { top, size }) {
  const rowHeight = Math.round(size * 2.1);
  const left = 60;
  const right = PAGE.width - 50;
  parts.push(
    `<rect x="${left}" y="${top}" width="${right - left}" height="${rowHeight}" fill="#e7ecf1"/>`,
  );
  for (const column of COLUMNS) {
    parts.push(
      text(
        column.align === "end" ? column.x + column.width : column.x,
        top + rowHeight * 0.68,
        column.title,
        { size, weight: "bold", fill: INK, anchor: column.align === "end" ? "end" : "start" },
      ),
    );
  }
  rows.forEach((entry, index) => {
    const y = top + rowHeight * (index + 1);
    if (index % 2 === 1) {
      parts.push(
        `<rect x="${left}" y="${y}" width="${right - left}" height="${rowHeight}" fill="#f6f7f9"/>`,
      );
    }
    const base = y + rowHeight * 0.68;
    const cells = [
      entry.article ?? "—",
      entry.brand ?? "",
      entry.name,
      priceText(entry.corrected ?? entry.price),
      entry.availability ?? "",
      entry.lead ?? "",
    ];
    cells.forEach((value, column) => {
      const spec = COLUMNS[column];
      parts.push(
        text(spec.align === "end" ? spec.x + spec.width : spec.x, base, value, {
          size,
          fill: INK,
          anchor: spec.align === "end" ? "end" : "start",
        }),
      );
    });
    if (entry.corrected) {
      // Crossed out, the new price written by hand in the same row, before it.
      const x = COLUMNS[3].x + COLUMNS[3].width;
      parts.push(
        `<line x1="${x - 95}" y1="${base - size * 0.35}" x2="${x + 4}" y2="${base - size * 0.35}" stroke="#1c3fae" stroke-width="3"/>`,
        text(x - 105, base, priceText(entry.price), {
          size: Math.round(size * 1.05),
          fill: "#1c3fae",
          font: "Comic Sans MS",
          anchor: "end",
        }),
      );
    }
    if (entry.stain) {
      const x = COLUMNS[3].x + COLUMNS[3].width - 60;
      parts.push(
        `<ellipse cx="${x}" cy="${base - size * 0.3}" rx="${size * 2.6}" ry="${size * 1.1}" fill="#8a5a2b" opacity="0.72"/>`,
        `<ellipse cx="${x + 10}" cy="${base - size * 0.2}" rx="${size * 1.7}" ry="${size * 0.7}" fill="#6f4520" opacity="0.4"/>`,
      );
    }
    parts.push(
      `<line x1="${left}" y1="${y + rowHeight}" x2="${right}" y2="${y + rowHeight}" stroke="#c9d1d9" stroke-width="1"/>`,
    );
  });
  return top + rowHeight * (rows.length + 1);
}

function pageOf(sample) {
  const parts = [`<rect width="${PAGE.width}" height="${PAGE.height}" fill="#ffffff"/>`];
  header(parts, sample);
  if (sample.kind === "letter") {
    const lines = [
      "Уважаемые партнёры!",
      "",
      "Сообщаем, что с 1 декабря склад работает с 9:00 до 19:00",
      "без перерыва, в субботу — до 15:00. Заказы, оформленные",
      "после 17:00, отгружаются на следующий рабочий день.",
      "",
      "Новый прайс-лист пришлём отдельным письмом.",
      "",
      "С уважением, отдел продаж (образец, данные выдуманы)",
    ];
    lines.forEach((line, index) => {
      parts.push(text(90, 320 + index * 52, line, { size: 30, fill: INK }));
    });
  } else {
    // The unreadable page: small print under a heavy blur — no person reads it.
    const size = sample.unreadable ? 11 : sample.small ? 15 : 24;
    const bottom = table(parts, sample.rows, { top: 260, size });
    parts.push(
      text(70, bottom + 60, "Цены действительны 7 дней. Образец, данные выдуманы.", {
        size: 20,
        fill: INK,
        opacity: 0.7,
      }),
    );
  }
  parts.push(watermark(PAGE.width, PAGE.height));
  if (sample.screen) {
    // A monitor around the page: a dark bezel, the page on its screen.
    const bezel = 70;
    const w = PAGE.width + bezel * 2;
    const h = PAGE.height + bezel * 2;
    return {
      width: w,
      height: h,
      svg: svgOf(w, h, [
        `<rect width="${w}" height="${h}" rx="26" fill="#16181b"/>`,
        `<g transform="translate(${bezel} ${bezel})">${parts.join("")}</g>`,
        // The lines of a screen photographed up close.
        ...Array.from(
          { length: 90 },
          (_, index) =>
            `<line x1="${bezel}" y1="${bezel + index * 20}" x2="${w - bezel}" y2="${bezel + index * 20}" stroke="#3a6bd1" stroke-width="1" opacity="0.06"/>`,
        ),
      ]),
    };
  }
  return { width: PAGE.width, height: PAGE.height, svg: svgOf(PAGE.width, PAGE.height, parts) };
}

function background() {
  const { width, height } = CANVAS;
  const parts = [
    `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8c8f93"/><stop offset="1" stop-color="#5c6066"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#t)"/>`,
  ];
  for (let i = 0; i < 24; i += 1) {
    const y = (height / 24) * i + ((i * 31) % 17);
    parts.push(
      `<path d="M0 ${y} C ${width / 3} ${y + 12} ${(2 * width) / 3} ${y - 12} ${width} ${y}" stroke="#3c3f44" stroke-width="2" fill="none" opacity="0.18"/>`,
    );
  }
  return svgOf(width, height, parts);
}

// --------------------------------------------------------------- run

function normalize(article) {
  return article.toUpperCase().replace(/[^A-Z0-9Ѐ-ӿ]+/g, "");
}

function leadDays(lead) {
  const match = lead === null ? null : /\d+/.exec(lead);
  return match ? Number(match[0]) : null;
}

function expectedRow(entry) {
  return {
    article: entry.article,
    articleNorm: entry.article ? normalize(entry.article) : null,
    brand: entry.brand,
    name: entry.name,
    price: entry.price,
    availability: entry.availability,
    leadDays: leadDays(entry.lead),
    // The model is expected to say it is unsure of the price under the stain or the correction.
    uncertainPrice: Boolean(entry.stain || entry.corrected),
  };
}

function entryOf(sample) {
  const kind =
    sample.kind === "letter" ? "not_a_table" : sample.unreadable ? "unreadable" : "price_list";
  return {
    id: sample.id,
    code: sample.code,
    variant: sample.variant,
    ...(sample.page ? { page: sample.page[0], pages: sample.page[1] } : {}),
    // A list a person could read: the thresholds of D-058 are counted on these rows.
    readable: kind === "price_list",
    ...(kind === "unreadable" ? { acceptKinds: ["unreadable", "not_a_table"] } : {}),
    expected: {
      kind,
      rows: kind === "price_list" ? sample.rows.map(expectedRow) : [],
    },
  };
}

const byId = new Map(SAMPLES.map((sample) => [sample.id, sample]));
await writeSet({
  directory: OUT,
  note: "Synthetic samples with made-up data (TASK-064). Generated by scripts/price-photo-samples.mjs — do not edit by hand.",
  samples: SAMPLES.map(entryOf),
  draw: (entry) => {
    const sample = byId.get(entry.id);
    return photograph(pageOf(sample), {
      variant: entry.variant,
      code: entry.code,
      canvas: CANVAS,
      background: background(),
    });
  },
});
