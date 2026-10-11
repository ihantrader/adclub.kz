import { describe, expect, it } from "vitest";
import {
  readArticle,
  readAvailability,
  readDecimal,
  readLeadDays,
  readPrice,
  readPriceRow,
  type PriceCell,
} from "./price-values";

describe("readDecimal", () => {
  it.each([
    ["12500", 12500],
    ["12 500", 12500],
    ["12\u00a0500", 12500],
    ["12\u202f500,00", 12500],
    ["12 500,50", 12500.5],
    ["12500.5", 12500.5],
    ["12,500.00", 12500],
    ["12.500,00", 12500],
    ["1.234.567", 1234567],
    ["1,234,567", 1234567],
    ["12,500", 12500],
    ["12,50", 12.5],
    ["0,500", 0.5],
    ["-15", -15],
    ["abc", null],
    ["12 500 тг", null],
    ["", null],
  ])("%s → %s", (value, expected) => {
    expect(readDecimal(value)).toBe(expected);
  });
});

describe("readPrice", () => {
  it.each<[PriceCell, ReturnType<typeof readPrice>]>([
    ["12 500", { kind: "price", value: 12500 }],
    ["12 500,00 ₸", { kind: "price", value: 12500 }],
    ["12500.5", { kind: "price", value: 12501 }],
    ["12500,49", { kind: "price", value: 12500 }],
    ["12 500 тг", { kind: "price", value: 12500 }],
    ["12 500 тг.", { kind: "price", value: 12500 }],
    ["12500 тенге", { kind: "price", value: 12500 }],
    ["12500 KZT", { kind: "price", value: 12500 }],
    ["₸ 7 990", { kind: "price", value: 7990 }],
    [12500, { kind: "price", value: 12500 }],
    [12500.5, { kind: "price", value: 12501 }],
    // A computed 9999,5 stored with float dust is still half a tenge up.
    [9999.499999999998, { kind: "price", value: 10000 }],
    [null, { kind: "missing" }],
    ["", { kind: "missing" }],
    ["-", { kind: "missing" }],
    ["по запросу", { kind: "not_number", text: "по запросу" }],
    ["договорная", { kind: "not_number", text: "договорная" }],
    ["от 12 500", { kind: "not_number", text: "от 12 500" }],
  ])("%j", (cell, expected) => {
    expect(readPrice(cell)).toEqual(expected);
  });
});

describe("readAvailability", () => {
  it.each<[PriceCell, string | null, number | null]>([
    ["есть", "in_stock", null],
    ["Есть", "in_stock", null],
    ["в наличии", "in_stock", null],
    ["Да", "in_stock", null],
    ["+", "in_stock", null],
    ["много", "in_stock", null],
    ["бар", "in_stock", null],
    ["қоймада бар", "in_stock", null],
    ["in stock", "in_stock", null],
    [5, "in_stock", 5],
    ["5", "in_stock", 5],
    ["12 шт", "in_stock", 12],
    [">10", "in_stock", 10],
    ["10+", "in_stock", 10],
    ["более 10", "in_stock", 10],
    ["нет", "out_of_stock", null],
    ["Нет в наличии", "out_of_stock", null],
    ["0", "out_of_stock", 0],
    [0, "out_of_stock", 0],
    ["-", "out_of_stock", null],
    ["жоқ", "out_of_stock", null],
    ["out of stock", "out_of_stock", null],
    ["под заказ", "on_order", null],
    ["Под заказ (3-5 дней)", "on_order", null],
    ["тапсырыспен", "on_order", null],
    ["on order", "on_order", null],
    [null, null, null],
    ["", null, null],
    ["уточняйте", null, null],
  ])("%j → %s", (cell, availability, quantity) => {
    expect(readAvailability(cell)).toEqual({ availability, quantity });
  });
});

describe("readLeadDays", () => {
  it.each<[PriceCell, number | null]>([
    ["3", 3],
    [3, 3],
    ["3 дня", 3],
    ["5 дней", 5],
    ["1 день", 1],
    ["2-3 дня", 3],
    ["2 – 3 дня", 3],
    ["от 2 до 4 дней", 4],
    ["до 5 дней", 5],
    ["5 р.д.", 5],
    ["3 күн", 3],
    ["7 days", 7],
    ["1 неделя", 5],
    ["2 нед", 10],
    ["сегодня", 0],
    ["завтра", 1],
    ["0", 0],
    [1.5, 2],
    [null, null],
    ["", null],
    ["по согласованию", null],
  ])("%j → %s", (cell, expected) => {
    expect(readLeadDays(cell)).toBe(expected);
  });
});

describe("readArticle", () => {
  it("keeps the article as written and its normal form", () => {
    expect(readArticle(" 04465-0K090 ")).toEqual({
      article: "04465-0K090",
      articleNorm: "044650K090",
    });
    expect(readArticle("gdb 3534")).toEqual({ article: "gdb 3534", articleNorm: "GDB3534" });
  });

  it("writes a number cell without an exponent", () => {
    expect(readArticle(4050068800)).toEqual({ article: "4050068800", articleNorm: "4050068800" });
  });

  it("has nothing to keep of punctuation alone", () => {
    expect(readArticle("—")).toBeNull();
    expect(readArticle(null)).toBeNull();
  });
});

describe("readPriceRow", () => {
  const limits = { priceMin: 1, priceMax: 50_000_000, leadDaysMax: 60 };
  const roles = ["article", "brand", "name", "price", "availability", "lead_days"] as const;

  it("reads a row by the roles of its columns", () => {
    expect(
      readPriceRow(
        [
          "04465-0K090",
          "Geely",
          "Колодки  тормозные передние",
          "12 500,00 ₸",
          "под заказ",
          "2-3 дня",
        ],
        roles,
        limits,
      ),
    ).toEqual({
      parsed: {
        article: "04465-0K090",
        articleNorm: "044650K090",
        brand: "Geely",
        name: "Колодки тормозные передние",
        price: 12500,
        availability: "on_order",
        quantity: null,
        leadDays: 3,
      },
      errors: [],
    });
  });

  it("ignores the columns marked «Не использовать»", () => {
    const reading = readPriceRow(["X1", "9 000", "12 000"], ["article", "ignore", "price"], limits);
    expect(reading.parsed.price).toBe(12000);
    expect(reading.errors).toEqual([]);
  });

  it("errs without a price, with a price that is not a number, or out of the limits", () => {
    expect(readPriceRow(["X1", null], ["article", "price"], limits).errors).toEqual([
      { code: "price_missing" },
    ]);
    expect(readPriceRow(["X1", "по запросу"], ["article", "price"], limits).errors).toEqual([
      { code: "price_not_number", text: "по запросу" },
    ]);
    expect(readPriceRow(["X1", "0"], ["article", "price"], limits).errors).toEqual([
      { code: "price_out_of_range", value: 0, min: 1, max: 50_000_000 },
    ]);
  });

  it("errs without an article and a name", () => {
    expect(readPriceRow([null, "  ", 500], ["article", "name", "price"], limits).errors).toEqual([
      { code: "no_article_or_name" },
    ]);
    expect(
      readPriceRow([null, "Фильтр", 500], ["article", "name", "price"], limits).errors,
    ).toEqual([]);
  });

  it("errs with a lead time beyond the limit and keeps every error of the row", () => {
    expect(
      readPriceRow([null, "договорная", "90 дней"], ["article", "price", "lead_days"], limits)
        .errors,
    ).toEqual([
      { code: "price_not_number", text: "договорная" },
      { code: "no_article_or_name" },
      { code: "lead_days_out_of_range", value: 90, max: 60 },
    ]);
  });
});
