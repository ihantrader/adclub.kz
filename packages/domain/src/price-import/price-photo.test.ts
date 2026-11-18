import { describe, expect, it } from "vitest";
import {
  agreePricePhotoPages,
  pricePhotoPage,
  pricePhotoRow,
  pricePhotoRowUncertain,
  PRICE_PHOTO_ROLES,
} from "./price-photo";
import { readPriceRow } from "./price-values";

const LIMITS = { priceMin: 1, priceMax: 10_000_000, leadDaysMax: 90 };

function row(overrides: Partial<Parameters<typeof pricePhotoRow>[0]> = {}) {
  return {
    text: "04465-0K090 Geely Колодки тормозные передние 18 500 есть",
    article: "04465-0K090",
    brand: "Geely",
    name: "Колодки тормозные передние",
    price: 18_500,
    availability: "есть",
    leadTime: null,
    uncertain: [],
    ...overrides,
  };
}

describe("pricePhotoRow", () => {
  it("keeps the cells in the order of the roles, read then as a file's row", () => {
    const checked = pricePhotoRow(row())!;
    expect(checked.cells).toEqual([
      "04465-0K090",
      "Geely",
      "Колодки тормозные передние",
      18_500,
      "есть",
      null,
    ]);
    const reading = readPriceRow(checked.cells, PRICE_PHOTO_ROLES, LIMITS);
    expect(reading.errors).toEqual([]);
    expect(reading.parsed).toMatchObject({
      articleNorm: "044650K090",
      price: 18_500,
      availability: "in_stock",
    });
    expect(pricePhotoRowUncertain(checked)).toBe(false);
  });

  it("cleans texts: control characters, spaces, length; empty — null", () => {
    const checked = pricePhotoRow(
      row({ name: "  Масло\u0000 моторное\n 5W-30 ", brand: "   ", article: "x".repeat(400) }),
    )!;
    expect(checked.cells[2]).toBe("Масло моторное 5W-30");
    expect(checked.cells[1]).toBeNull();
    expect((checked.cells[0] as string).length).toBe(300);
  });

  it("a price that is no number is dropped and the row becomes uncertain", () => {
    for (const price of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const checked = pricePhotoRow(row({ price }))!;
      expect(checked.cells[3]).toBeNull();
      expect(checked.uncertain).toContain("price");
      expect(readPriceRow(checked.cells, PRICE_PHOTO_ROLES, LIMITS).errors).toEqual([
        { code: "price_missing" },
      ]);
    }
  });

  it("keeps only known uncertainties, once, the row first", () => {
    const checked = pricePhotoRow(
      row({ uncertain: ["price", "bogus", "row", "price", "article"] }),
    )!;
    expect(checked.uncertain).toEqual(["row", "article", "price"]);
    expect(pricePhotoRowUncertain(checked)).toBe(true);
  });

  it("a row with neither an article, a name nor a price is nothing to import", () => {
    expect(pricePhotoRow(row({ article: null, name: " ", price: null }))).toBeNull();
    // A name with no price is a row with an error, not nothing.
    expect(pricePhotoRow(row({ article: null, price: null }))).not.toBeNull();
  });

  it("the source text falls back to the cells", () => {
    const checked = pricePhotoRow(row({ text: null }))!;
    expect(checked.text).toBe("04465-0K090 · Geely · Колодки тормозные передние · 18500 · есть");
  });
});

describe("agreePricePhotoPages", () => {
  const list = (...rows: ReturnType<typeof row>[]) => pricePhotoPage({ kind: "price_list", rows });
  const pads = row();
  const trw = row({ article: "GDB3534", brand: "TRW", price: 14_200 });
  const oil = row({ article: null, name: "Shell Helix HX8 5W-30, 4 л", price: 21_400 });

  it("keeps the rows both readings give, with the doubts of either", () => {
    const page = agreePricePhotoPages(
      list(pads, trw, oil),
      list(row({ article: "04465 0K090" }), { ...trw, uncertain: ["price"] }, oil),
    );
    expect(page.kind).toBe("rows");
    if (page.kind !== "rows") return;
    expect(page.rows.map((entry) => entry.uncertain)).toEqual([[], ["price"], []]);
  });

  it("a row the second reading doesn't confirm (another price, missing) is doubtful as a whole", () => {
    const page = agreePricePhotoPages(
      list(pads, trw, oil),
      list(pads, { ...trw, price: 17_200 }, oil),
    );
    if (page.kind !== "rows") throw new Error("rows expected");
    expect(page.rows[1]!.uncertain).toEqual(["row"]);
    expect(pricePhotoRowUncertain(page.rows[0]!)).toBe(false);
  });

  it("stock read differently — «есть» once, «нет» the other time — is doubtful", () => {
    const page = agreePricePhotoPages(
      list(pads, trw, oil),
      list(pads, { ...trw, availability: "нет" }, oil),
    );
    if (page.kind !== "rows") throw new Error("rows expected");
    expect(page.rows[1]!.uncertain).toEqual(["row"]);
    // «в наличии» and «есть» say the same.
    const same = agreePricePhotoPages(list(pads), list({ ...pads, availability: "в наличии" }));
    if (same.kind !== "rows") throw new Error("rows expected");
    expect(same.rows[0]!.uncertain).toEqual([]);
  });

  it("one row of the second reading confirms one row of the first", () => {
    const page = agreePricePhotoPages(list(pads, pads, trw), list(pads, trw));
    if (page.kind !== "rows") throw new Error("rows expected");
    expect(page.rows.map((entry) => entry.uncertain)).toEqual([[], ["row"], []]);
  });

  it("a page whose readings mostly disagree was made up: unreadable", () => {
    const invented = list(
      row({ article: "AAAA-1", price: 10_500 }),
      row({ article: "BBBB-2", price: 14_000 }),
      row({ article: "CCCC-3", price: 12_000 }),
    );
    const other = list(
      row({ article: "1AM 33501", price: 3_800 }),
      row({ article: "BBBB-2", price: 14_000 }),
      row({ article: "Z 206", price: 4_200 }),
    );
    expect(agreePricePhotoPages(invented, other)).toEqual({ kind: "unreadable" });
    expect(agreePricePhotoPages(invented, { kind: "no_table" })).toEqual({ kind: "unreadable" });
    expect(agreePricePhotoPages({ kind: "no_table" }, invented)).toEqual({ kind: "no_table" });
  });
});

describe("pricePhotoPage", () => {
  it("a list of rows", () => {
    const page = pricePhotoPage({ kind: "price_list", rows: [row(), row({ article: "GDB3534" })] });
    expect(page.kind).toBe("rows");
    if (page.kind === "rows") expect(page.rows).toHaveLength(2);
  });

  it("not a table, unreadable, and a list without a single row", () => {
    expect(pricePhotoPage({ kind: "not_a_table", rows: [row()] })).toEqual({ kind: "no_table" });
    expect(pricePhotoPage({ kind: "unreadable", rows: [] })).toEqual({ kind: "unreadable" });
    expect(pricePhotoPage({ kind: "price_list", rows: [] })).toEqual({ kind: "no_table" });
    expect(
      pricePhotoPage({
        kind: "price_list",
        rows: [row({ article: null, name: null, price: null })],
      }),
    ).toEqual({ kind: "no_table" });
  });

  it("cuts a page that gives more rows than a page holds", () => {
    const page = pricePhotoPage({
      kind: "price_list",
      rows: Array.from({ length: 1005 }, (_, index) => row({ article: `A${String(index)}` })),
    });
    expect(page).toMatchObject({ kind: "rows", dropped: 5 });
    if (page.kind === "rows") expect(page.rows).toHaveLength(1000);
  });
});
