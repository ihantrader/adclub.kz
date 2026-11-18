import type { PricePhotoOutput } from "./ai-gateway";

/**
 * What the test AI provider answers for the synthetic photographed price
 * pages of TASK-064, by the code of their control strip (drawn by
 * `scripts/price-photo-samples.mjs`, read as the strips of TASK-057/058). A
 * page without a strip — any real photo in development — is unreadable.
 * `photo-fixtures.test.ts` checks these rows against the expected rows of
 * `ai-eval/price-photo/samples.json`.
 *
 * The rows under a stain and a correction by hand are answered as a careful
 * model would: read, with the price marked uncertain.
 */

type Row = PricePhotoOutput["rows"][number];

function row(
  article: string | null,
  brand: string,
  name: string,
  price: number,
  availability = "есть",
  leadTime: string | null = null,
  uncertain: Row["uncertain"] = [],
): Row {
  const priceText = String(price).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return {
    text: [article ?? "—", brand, name, priceText, availability, leadTime ?? ""]
      .filter((cell) => cell !== "")
      .join(" | "),
    article,
    brand,
    name,
    price,
    availability,
    leadTime,
    uncertain,
  };
}

const LIST: Row[] = [
  row("04465-0K090", "GEELY", "Колодки тормозные передние", 18_500),
  row("GDB3534", "TRW", "Колодки тормозные передние TRW", 14_200),
  row("4050068800", "GEELY", "Колодки тормозные задние", 16_900, "под заказ", "3 дня"),
  row(null, "Shell", "Shell Helix HX8 5W-30, 4 л", 21_400),
  row(null, "Mobil", "Mobil Super 3000 5W-40, 4 л", 19_800, "нет"),
  row("ST-55120", "Стартвольт", "Свеча зажигания иридиевая", 3_450),
];

const PAGE_1: Row[] = LIST.slice(0, 4);

const PAGE_2: Row[] = [
  row(null, "Shell", "Shell Helix Ultra 0W-20, 1 л", 6_300, "есть", null, ["price"]),
  row(null, "Mobil", "Mobil 1 ESP 5W-30", 24_000, "2 шт"),
  row("FM-301", "Фильтрон", "Фильтр масляный", 2_100),
];

const SMALL: Row[] = [
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

const CORRECTED: Row[] = LIST.map((entry) =>
  entry.article === "4050068800"
    ? row("4050068800", "GEELY", "Колодки тормозные задние", 17_500, "под заказ", "3 дня", [
        "price",
      ])
    : entry,
);

function list(rows: Row[]): PricePhotoOutput {
  return { kind: "price_list", rows: rows.map((entry) => ({ ...entry })) };
}

const NOT_A_TABLE: PricePhotoOutput = { kind: "not_a_table", rows: [] };
const UNREADABLE: PricePhotoOutput = { kind: "unreadable", rows: [] };

export const TEST_PRICE_PHOTOS: Readonly<Record<number, PricePhotoOutput>> = {
  1: list(LIST),
  2: list(PAGE_1),
  3: list(PAGE_2),
  4: list(LIST),
  5: list(SMALL),
  6: list(LIST),
  7: list(CORRECTED),
  8: NOT_A_TABLE,
  9: UNREADABLE,
};

/** The answer for a page without a strip, or in the mode `unreadable`. */
export const TEST_PRICE_PHOTO_UNREADABLE = UNREADABLE;
