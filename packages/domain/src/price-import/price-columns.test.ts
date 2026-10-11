import { describe, expect, it } from "vitest";
import {
  classifyPriceRow,
  findPriceHeader,
  guessRoleByHeader,
  missingPriceRoles,
  priceHeaderKey,
  priceRolesProblem,
  recognizePriceColumns,
} from "./price-columns";
import type { PriceCell } from "./price-values";

describe("guessRoleByHeader", () => {
  it.each<[string, string | null]>([
    // Russian
    ["Артикул", "article"],
    ["Код", "article"],
    ["Каталожный номер", "article"],
    ["OEM", "article"],
    ["Наименование", "name"],
    ["Номенклатура", "name"],
    ["Наименование товара", "name"],
    ["Цена", "price"],
    ["Цена, тг", "price"],
    ["Розница", "price"],
    ["Опт", "price"],
    ["Наличие", "availability"],
    ["Остаток", "availability"],
    ["Кол-во", "availability"],
    ["Склад", "availability"],
    ["Срок", "lead_days"],
    ["Срок поставки, дн", "lead_days"],
    ["Бренд", "brand"],
    ["Производитель", "brand"],
    ["Марка", "brand"],
    // Kazakh
    ["Атауы", "name"],
    ["Тауар атауы", "name"],
    ["Бағасы", "price"],
    ["Бағасы, ₸", "price"],
    ["Қалдық", "availability"],
    ["Жеткізу мерзімі", "lead_days"],
    ["Өндіруші", "brand"],
    ["Каталог нөмірі", "article"],
    // English
    ["Part No", "article"],
    ["Part Number", "article"],
    ["SKU", "article"],
    ["Description", "name"],
    ["Price", "price"],
    ["Retail price", "price"],
    ["Stock", "availability"],
    ["Qty", "availability"],
    ["Lead time", "lead_days"],
    ["Brand", "brand"],
    // Nothing
    ["№", null],
    ["Примечание", null],
    ["", null],
  ])("%s → %s", (header, role) => {
    expect(guessRoleByHeader(header)?.role ?? null).toBe(role);
  });

  it("is less sure of wholesale than of retail", () => {
    expect(guessRoleByHeader("Опт")!.score).toBeLessThan(guessRoleByHeader("Розница")!.score);
    expect(guessRoleByHeader("Цена опт")!.score).toBeLessThan(guessRoleByHeader("Цена, тг")!.score);
    expect(guessRoleByHeader("Цена оптовая")!.score).toBe(0.5);
  });
});

describe("findPriceHeader", () => {
  it("passes over the title of a 1C export", () => {
    const rows: PriceCell[][] = [
      ["ТОО «Автомир Степь»"],
      ["Прайс-лист на 10.10.2026"],
      ["г. Алматы, ул. Примерная, 1"],
      [null, null, "Тел. +7 701 000 0360"],
      ["Код", "Артикул", "Номенклатура", "Опт", "Цена, тг", "Остаток"],
      ["00001", "04465-0K090", "Колодки тормозные", 9800, 12500, 4],
    ];
    expect(findPriceHeader(rows)).toBe(4);
  });

  it("finds a header of Kazakh words", () => {
    expect(
      findPriceHeader([
        ["Атауы", "Бағасы", "Қалдық"],
        ["Сүзгі", 3500, 2],
      ]),
    ).toBe(0);
  });

  it("finds a header of unknown words by the goods under it", () => {
    expect(
      findPriceHeader([
        ["Позиция", "Стоимость позиции товара"],
        ["Фильтр масляный", "3 500"],
      ]),
    ).toBe(0);
    expect(
      findPriceHeader([
        ["Колонка А", "Колонка Б"],
        ["Фильтр масляный", "3 500"],
      ]),
    ).toBe(0);
  });

  it("has nothing when the first row is goods", () => {
    expect(findPriceHeader([["04465-0K090", "Колодки", 12500]])).toBeNull();
  });
});

describe("classifyPriceRow", () => {
  const key = priceHeaderKey(["Артикул", "Наименование", "Цена"]);
  it.each<[PriceCell[], string]>([
    [["X1", "Фильтр", 500], "data"],
    [["ТОРМОЗНАЯ СИСТЕМА"], "group"],
    [[null, "ТОРМОЗНАЯ СИСТЕМА", null], "group"],
    [["Итого", null, 125000], "total"],
    [["ИТОГО:", null, 125000], "total"],
    [["Барлығы", null, 125000], "total"],
    [["артикул", "НАИМЕНОВАНИЕ", "Цена"], "repeat_header"],
    [[null, null, 500], "data"],
  ])("%j → %s", (cells, kind) => {
    expect(classifyPriceRow(cells, key)).toBe(kind);
  });
});

describe("priceHeaderKey", () => {
  it("is one for the same columns written differently", () => {
    expect(priceHeaderKey(["Артикул", "Цена, тг.", null])).toBe(
      priceHeaderKey(["АРТИКУЛ ", "цена тг", ""]),
    );
    expect(priceHeaderKey(["Артикул", "Цена"])).not.toBe(priceHeaderKey(["Цена", "Артикул"]));
  });
});

describe("recognizePriceColumns", () => {
  it("recognises a 1C export by its headers and leaves the wholesale price to the supplier", () => {
    const guesses = recognizePriceColumns(
      ["Код", "Артикул", "Номенклатура", "Опт", "Цена, тг", "Остаток"],
      [["00001", "04465-0K090", "Колодки тормозные передние", 9800, 12500, 4]],
      6,
    );
    expect(guesses.map((guess) => guess.role)).toEqual([
      "ignore",
      "article",
      "name",
      "ignore",
      "price",
      "availability",
    ]);
    expect(guesses[1]!.source).toBe("header");
    expect(guesses[3]!.source).toBeNull();
  });

  it("gives the price to «Розница» rather than «Опт», whichever comes first", () => {
    const roles = recognizePriceColumns(["Наименование", "Розница", "Опт"], [], 3).map(
      (guess) => guess.role,
    );
    expect(roles).toEqual(["name", "price", "ignore"]);
  });

  it("recognises Kazakh and English headers", () => {
    expect(
      recognizePriceColumns(
        ["Каталог нөмірі", "Өндіруші", "Атауы", "Бағасы", "Қалдық", "Жеткізу мерзімі"],
        [],
        6,
      ).map((guess) => guess.role),
    ).toEqual(["article", "brand", "name", "price", "availability", "lead_days"]);
    expect(
      recognizePriceColumns(["Part No", "Brand", "Description", "Price", "Qty"], [], 5).map(
        (guess) => guess.role,
      ),
    ).toEqual(["article", "brand", "name", "price", "availability"]);
  });

  it("recognises columns by their cells when the header says nothing", () => {
    const samples: PriceCell[][] = [
      ["04465-0K090", "Колодки тормозные передние Geely", "12 500", "есть"],
      ["GDB3534", "Колодки тормозные TRW передние", "9 800", "нет"],
      ["4050068800", "Колодки тормозные задние", "7 300", "под заказ"],
      ["SH-HX8-4L", "Масло моторное Shell Helix HX8 5W-30", "21 000", "есть"],
    ];
    const guesses = recognizePriceColumns(["К1", "К2", "К3", "К4"], samples, 4);
    expect(guesses.map((guess) => guess.role)).toEqual([
      "article",
      "name",
      "price",
      "availability",
    ]);
    expect(guesses.every((guess) => guess.source === "content")).toBe(true);
  });

  it("works without a header row at all", () => {
    const samples: PriceCell[][] = [
      ["04465-0K090", "Колодки тормозные передние Geely", 12500],
      ["GDB3534", "Колодки тормозные TRW передние", 9800],
    ];
    expect(recognizePriceColumns(null, samples, 3).map((guess) => guess.role)).toEqual([
      "article",
      "name",
      "price",
    ]);
  });

  it("of two unnamed price columns takes the dearer one", () => {
    const samples: PriceCell[][] = [
      ["Фильтр масляный оригинальный", 3000, 3500],
      ["Фильтр воздушный салонный", 4000, 4600],
    ];
    expect(recognizePriceColumns(null, samples, 3).map((guess) => guess.role)).toEqual([
      "name",
      "ignore",
      "price",
    ]);
  });
});

describe("required roles", () => {
  it("need a price and an article or a name", () => {
    expect(missingPriceRoles(["article", "price"])).toEqual([]);
    expect(missingPriceRoles(["name", "price"])).toEqual([]);
    expect(missingPriceRoles(["name", "ignore"])).toEqual(["price"]);
    expect(missingPriceRoles(["brand", "price"])).toEqual(["article_or_name"]);
  });

  it("take each role once", () => {
    expect(priceRolesProblem(["article", "price", "ignore", "ignore"])).toBeNull();
    expect(priceRolesProblem(["price", "price", "article"])).toEqual({
      kind: "repeated",
      role: "price",
    });
    expect(priceRolesProblem(["article"])).toEqual({ kind: "missing" });
  });
});
