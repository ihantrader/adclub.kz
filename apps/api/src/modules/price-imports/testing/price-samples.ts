import { writeXlsx, type XlsxValue } from "./xlsx-writer";

/**
 * Invented price lists that look like the ones Kazakhstan suppliers send
 * (TASK-046 AC-5): a 1C export with a company title, a CSV in Windows-1251
 * with «;», a clean workbook with Kazakh headers and a file full of row
 * errors. Every company, address and number here is made up; the phones are
 * the project's test numbers. The same builders give the example files of
 * `apps/api/fixtures/price-imports` (`pnpm --filter @adclub/api
 * price-imports:samples`) and the files of the tests.
 */

/** Windows-1251 bytes of a text (only the characters the samples use). */
export function encodeWin1251(text: string): Buffer {
  const extra: Record<string, number> = {
    Ё: 0xa8,
    ё: 0xb8,
    "№": 0xb9,
    "«": 0xab,
    "»": 0xbb,
    "–": 0x96,
    "—": 0x97,
  };
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else if (extra[character] !== undefined) bytes.push(extra[character]);
    else throw new Error(`No Windows-1251 byte for «${character}»`);
  }
  return Buffer.from(bytes);
}

/** A tiny deterministic generator: the same file every time. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

interface Part {
  article: string;
  brand: string;
  name: string;
  price: number;
}

const GROUPS: readonly { title: string; parts: readonly string[] }[] = [
  {
    title: "ТОРМОЗНАЯ СИСТЕМА",
    parts: [
      "Колодки тормозные передние",
      "Колодки тормозные задние",
      "Диск тормозной передний",
      "Диск тормозной задний",
      "Датчик износа колодок",
      "Шланг тормозной передний",
    ],
  },
  {
    title: "ФИЛЬТРЫ",
    parts: ["Фильтр масляный", "Фильтр воздушный", "Фильтр салонный угольный", "Фильтр топливный"],
  },
  {
    title: "ПОДВЕСКА",
    parts: [
      "Амортизатор передний газовый",
      "Амортизатор задний газовый",
      "Стойка стабилизатора передняя",
      "Сайлентблок рычага передний",
      "Опора шаровая",
      "Наконечник рулевой тяги",
    ],
  },
  {
    title: "ДВИГАТЕЛЬ",
    parts: [
      "Свеча зажигания иридиевая",
      "Ремень приводной поликлиновой",
      "Помпа водяная",
      "Прокладка клапанной крышки",
      "Датчик кислородный",
      "Катушка зажигания",
    ],
  },
];

const BRANDS = ["Geely", "TRW", "Bosch", "Mann", "NGK", "Sachs", "Febi", "Chery"];
const MODELS = [
  "Geely Coolray",
  "Geely Atlas",
  "Geely Monjaro",
  "Geely Tugella",
  "Chery Tiggo 7 Pro",
];

function part(next: () => number, group: number, index: number): Part {
  const names = GROUPS[group]!.parts;
  const brand = BRANDS[Math.floor(next() * BRANDS.length)]!;
  const model = MODELS[Math.floor(next() * MODELS.length)]!;
  const digits = String(Math.floor(next() * 9_000_000) + 1_000_000);
  const article =
    brand === "Geely" || brand === "Chery"
      ? `${digits.slice(0, 5)}-${String(index).padStart(2, "0")}${digits.slice(5)}`
      : `${brand.slice(0, 3).toUpperCase()}${digits.slice(0, 5)}`;
  return {
    article,
    brand,
    name: `${names[index % names.length]!} ${model}`,
    price: Math.round((1500 + next() * 60_000) / 10) * 10,
  };
}

/**
 * A 1C export («Прайс-лист» of «Управление торговлей»): the company, the
 * date, the address and a phone above the table; «Код» of 1C, «Артикул»,
 * «Номенклатура», «Ед.», «Опт», «Цена, тг», «Остаток»; groups as rows of
 * one cell, «Итого» at the end; `onRequest` rows with «по запросу» for a
 * price. 1 240 rows of goods by default, twelve of them on request.
 */
export function oneCExport(rows = 1240, onRequest = 12): Buffer {
  const next = random(46);
  const table: (XlsxValue[] | null)[] = [
    ["ТОО «Автомир Степь»"],
    ["Прайс-лист на 10.10.2026"],
    ["г. Алматы, ул. Примерная, 15, бокс 3"],
    ["Тел.: +7 701 000 0360, +7 701 000 0361"],
    null,
    ["Код", "Артикул", "Номенклатура", "Ед.", "Опт", "Цена, тг", "Остаток"],
  ];
  const perGroup = Math.ceil(rows / GROUPS.length);
  const requestEvery = onRequest > 0 ? Math.floor(rows / onRequest) : 0;
  let made = 0;
  let requested = 0;
  for (let group = 0; group < GROUPS.length && made < rows; group++) {
    table.push([GROUPS[group]!.title]);
    for (let index = 0; index < perGroup && made < rows; index++) {
      const item = part(next, group, index);
      made++;
      const askPrice = requestEvery > 0 && made % requestEvery === 0 && requested < onRequest;
      if (askPrice) requested++;
      const stock = Math.floor(next() * 12);
      table.push([
        String(made).padStart(9, "0"),
        item.article,
        `${item.name} ${item.brand}`,
        "шт",
        askPrice ? "по запросу" : Math.round(item.price * 0.82),
        askPrice ? "по запросу" : item.price,
        stock,
      ]);
    }
  }
  table.push(["Итого", null, null, null, null, null, null]);
  return writeXlsx([
    { name: "TDSheet", rows: table, merges: ["A1:G1", "A2:G2", "A3:G3", "A4:G4"] },
  ]);
}

/**
 * A CSV of an accounting program saved by Excel in a Russian Windows:
 * Windows-1251, «;», prices as «12 500,00», availability in words, terms in
 * days and ranges.
 */
export function cp1251Csv(rows = 300): Buffer {
  const next = random(1251);
  const lines = ["Артикул;Производитель;Наименование;Цена;Наличие;Срок поставки, дн"];
  const availability = ["есть", "в наличии", "нет", "под заказ", "5", "0", ">10"];
  for (let index = 0; index < rows; index++) {
    const item = part(next, index % GROUPS.length, index);
    const price = item.price.toLocaleString("ru-RU").replace(/\u00a0/g, " ");
    const stock = availability[Math.floor(next() * availability.length)]!;
    const term =
      stock === "под заказ" ? `${String(2 + (index % 3))}-${String(4 + (index % 3))} дня` : "0";
    lines.push([item.article, item.brand, `"${item.name}"`, `${price},00`, stock, term].join(";"));
  }
  return encodeWin1251(`${lines.join("\r\n")}\r\n`);
}

/** A clean workbook with Kazakh headers. */
export function kazakhXlsx(rows = 200): Buffer {
  const next = random(7);
  const table: XlsxValue[][] = [
    ["Каталог нөмірі", "Өндіруші", "Атауы", "Бағасы, ₸", "Қалдық", "Жеткізу мерзімі"],
  ];
  for (let index = 0; index < rows; index++) {
    const item = part(next, index % GROUPS.length, index);
    const inStock = next() > 0.3;
    table.push([
      item.article,
      item.brand,
      item.name,
      item.price,
      inStock ? "бар" : "тапсырыспен",
      inStock ? 0 : `${String(2 + (index % 4))} күн`,
    ]);
  }
  return writeXlsx([{ name: "Бағалар", rows: table }]);
}

/**
 * A price list with mistakes of every kind: no price, «договорная», a price
 * of zero and one beyond the limit, a row without an article and a name, a
 * term of 120 days; between good rows, so the rest is read.
 */
export function withErrorsCsv(): Buffer {
  const lines = [
    "Артикул;Наименование;Цена;Наличие;Срок",
    "04465-0K090;Колодки тормозные передние Geely Atlas;12 500;есть;",
    "GDB3534;Колодки тормозные передние TRW;;есть;",
    "4050068800;Колодки тормозные задние Geely;договорная;нет;",
    "1016051345;Фильтр масляный Geely Coolray;0;есть;",
    "SH-HX8-4L;Масло моторное Shell Helix HX8 5W-30, 4 л;150 000 000;есть;",
    ";;3 500;есть;",
    "MANN-HU7020Z;Фильтр масляный Mann;4 200;под заказ;120 дней",
    "NGK-ILKAR7L11;Свеча зажигания NGK;3 900;5;",
    "BOSCH-0986494;Колодки тормозные задние Bosch;по запросу;под заказ;3-5 дней",
    "TRW-DF6534;Диск тормозной передний TRW;21 300;в наличии;",
  ];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/** A letter, not a table — «Не удалось прочитать файл». */
export function notATable(): Buffer {
  return Buffer.from(
    "Добрый день!\nВысылаем наш прайс-лист отдельным письмом.\nС уважением, отдел продаж.\n",
    "utf8",
  );
}

export const PRICE_SAMPLE_FILES: readonly { file: string; build: () => Buffer }[] = [
  { file: "1c-export.xlsx", build: () => oneCExport() },
  { file: "cp1251-semicolon.csv", build: () => cp1251Csv() },
  { file: "kazakh-columns.xlsx", build: () => kazakhXlsx() },
  { file: "with-errors.csv", build: () => withErrorsCsv() },
  { file: "not-a-table.txt", build: () => notATable() },
];
