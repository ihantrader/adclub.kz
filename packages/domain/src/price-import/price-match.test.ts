import { describe, expect, it } from "vitest";
import {
  candidateScore,
  exactArticleDecision,
  isStrongCandidate,
  nameTokens,
  priceNameKey,
  priceRowKey,
  rankCandidates,
  repeatedRows,
  searchWords,
  sharpPriceChange,
  strongCandidate,
  type NameCandidate,
} from "./price-match";

const shellHx8: NameCandidate = {
  itemId: "a",
  name: "Shell Helix HX8 5W-30, 4 л",
  brandSpellings: ["Shell"],
  article: null,
  context: "Моторные масла Масла и жидкости",
};
const shellHx8OneLitre: NameCandidate = {
  itemId: "b",
  name: "Shell Helix HX8 5W-30, 1 л",
  brandSpellings: ["Shell"],
  article: null,
  context: "Моторные масла Масла и жидкости",
};
const mobil: NameCandidate = {
  itemId: "c",
  name: "Mobil Super 3000 5W-30, 4 л",
  brandSpellings: ["Mobil"],
  article: null,
};

describe("nameTokens", () => {
  it.each<[string, string[]]>([
    ["Shell Helix HX8 5W-30, 4 л", ["shell", "helix", "hx8", "5w30", "4", "л"]],
    ["Масло 5w30 4л", ["масло", "5w30", "4", "л"]],
    ["Колодки 04465-0K090", ["колодки", "044650k090"]],
    ["Объём 1,5 л", ["объем", "1.5", "л"]],
    ["Ёлка / ель", ["елка", "ель"]],
    ["HX8", ["hx8"]],
  ])("%s", (text, tokens) => {
    expect(nameTokens(text)).toEqual(tokens);
  });
});

describe("priceRowKey", () => {
  it("is the article when there is one", () => {
    expect(priceRowKey({ articleNorm: "044650K090", name: "Колодки" })).toEqual({
      kind: "article",
      key: "044650K090",
    });
  });

  it("is the name, normalized, without an article", () => {
    expect(priceRowKey({ articleNorm: null, name: "  Масло   5W-30,  4Л " })).toEqual({
      kind: "name",
      key: "масло 5w30 4 л",
    });
    expect(priceNameKey("Масло 5W-30 4 л")).toBe(priceNameKey("масло 5w30 4л"));
  });

  it("is nothing without either", () => {
    expect(priceRowKey({ articleNorm: null, name: null })).toBeNull();
    expect(priceRowKey({ articleNorm: null, name: " , " })).toBeNull();
  });
});

describe("repeatedRows", () => {
  it("lets the first row decide and names it in the later ones", () => {
    const key = (k: string) => ({ kind: "article" as const, key: k });
    const repeated = repeatedRows([
      { rowNo: 5, key: key("A") },
      { rowNo: 7, key: key("B") },
      { rowNo: 9, key: key("A") },
      { rowNo: 12, key: key("A") },
      { rowNo: 13, key: null },
      { rowNo: 14, key: { kind: "name", key: "A" } },
    ]);
    expect([...repeated]).toEqual([
      [9, 5],
      [12, 5],
    ]);
  });
});

describe("exactArticleDecision", () => {
  const geely = { itemId: "g", brandId: "brand-geely" };
  const trw = { itemId: "t", brandId: "brand-trw" };

  it("finds nothing without items", () => {
    expect(exactArticleDecision([], ["brand-geely"])).toEqual({ kind: "none" });
  });

  it("is sure of the item of the row's brand", () => {
    expect(exactArticleDecision([geely, trw], ["brand-geely"])).toEqual({
      kind: "confident",
      itemId: "g",
    });
  });

  it("is sure of a single item when the row names no brand or one nobody knows", () => {
    expect(exactArticleDecision([geely], [])).toEqual({ kind: "confident", itemId: "g" });
  });

  it("asks the supplier when the brand doesn't decide", () => {
    expect(exactArticleDecision([geely, trw], [])).toEqual({
      kind: "review",
      itemIds: ["g", "t"],
      reason: "several_brands",
    });
  });

  it("asks the supplier when the row's brand has no item with the article", () => {
    expect(exactArticleDecision([trw], ["brand-geely"])).toEqual({
      kind: "review",
      itemIds: ["t"],
      reason: "other_brand",
    });
  });
});

describe("the strong candidate", () => {
  it("takes the item whose words, sizes and brand are all in the row", () => {
    const row = { name: "Масло моторное Shell Helix HX8 5W-30 4л", brand: null };
    expect(isStrongCandidate(row, shellHx8)).toBe(true);
    expect(strongCandidate(row, [shellHx8, shellHx8OneLitre, mobil])).toBe(shellHx8);
  });

  it("accepts the brand from its own cell", () => {
    expect(isStrongCandidate({ name: "Helix HX8 5W-30 4 л", brand: "SHELL" }, shellHx8)).toBe(true);
  });

  it("refuses when a size differs", () => {
    expect(isStrongCandidate({ name: "Shell Helix HX8 5W-30 5л", brand: null }, shellHx8)).toBe(
      false,
    );
  });

  it("refuses when the row has a characteristic the item doesn't", () => {
    expect(
      isStrongCandidate({ name: "Shell Helix HX8 5W-30 4л 550040", brand: null }, shellHx8),
    ).toBe(false);
  });

  it("refuses when a word of the item is missing from the row", () => {
    expect(isStrongCandidate({ name: "Shell HX8 5W-30 4л", brand: null }, shellHx8)).toBe(false);
  });

  it("refuses when the brand isn't named", () => {
    expect(isStrongCandidate({ name: "Helix HX8 5W-30 4л", brand: "Mobil" }, shellHx8)).toBe(false);
  });

  it("refuses a name that says too little", () => {
    const short: NameCandidate = { itemId: "x", name: "Масло", brandSpellings: [], article: null };
    expect(isStrongCandidate({ name: "Масло", brand: null }, short)).toBe(false);
  });

  it("takes words in another form", () => {
    const pads: NameCandidate = {
      itemId: "p",
      name: "Колодки тормозные передние",
      brandSpellings: [],
      article: null,
    };
    expect(isStrongCandidate({ name: "Колодка тормозная передняя", brand: null }, pads)).toBe(true);
  });

  it("refuses a row that says more than the item, its brand and category do", () => {
    const atlasPads: NameCandidate = {
      itemId: "p",
      name: "Колодки тормозные передние",
      brandSpellings: ["Geely", "Джили"],
      article: "04465-0K090",
      context: "Тормозные колодки Тормоза",
    };
    expect(
      isStrongCandidate(
        { name: "Колодки тормозные передние Geely Coolray", brand: null },
        atlasPads,
      ),
    ).toBe(false);
    expect(
      isStrongCandidate({ name: "Колодки тормозные передние", brand: "ДЖИЛИ" }, atlasPads),
    ).toBe(true);
    // Without the category «масло моторное» is a word the item doesn't name.
    expect(
      isStrongCandidate(
        { name: "Масло моторное Shell Helix HX8 5W-30 4л", brand: null },
        { ...shellHx8, context: undefined },
      ),
    ).toBe(false);
  });

  it("refuses an item with another article, however alike the names", () => {
    const pads: NameCandidate = {
      itemId: "p",
      name: "Колодки тормозные передние",
      brandSpellings: ["Sachs"],
      article: "SAC28522",
      context: "Тормозные колодки",
    };
    const row = { name: "Колодки тормозные передние Sachs", brand: null };
    expect(isStrongCandidate({ ...row, articleNorm: "SAC28522" }, pads)).toBe(true);
    expect(isStrongCandidate({ ...row, articleNorm: "SAC91003" }, pads)).toBe(false);
    expect(isStrongCandidate({ ...row, articleNorm: null }, pads)).toBe(true);
  });

  it("is nobody when two candidates are strong", () => {
    const twin = { ...shellHx8, itemId: "twin" };
    expect(
      strongCandidate({ name: "Shell Helix HX8 5W-30 4л", brand: null }, [shellHx8, twin]),
    ).toBeNull();
  });
});

describe("ranking candidates", () => {
  it("puts the closest first and drops what shares nothing", () => {
    const row = { name: "Масло Shell Helix HX8 5W-30 4л", brand: null };
    const unrelated: NameCandidate = {
      itemId: "z",
      name: "Тормозной диск",
      brandSpellings: [],
      article: null,
    };
    const ranked = rankCandidates(row, [mobil, unrelated, shellHx8OneLitre, shellHx8], 3);
    expect(ranked.map((entry) => entry.candidate.itemId)).toEqual(["a", "b", "c"]);
    expect(candidateScore(row, unrelated)).toBe(0);
  });

  it("searches by the longest words and marks", () => {
    expect(
      searchWords({ name: "Масло моторное Shell Helix HX8 5W-30 4л", brand: null }, 3),
    ).toEqual(["моторное", "helix", "shell"]);
  });
});

describe("sharpPriceChange", () => {
  it.each<[number | null, number, number, boolean]>([
    [10_000, 13_000, 30, false],
    [10_000, 13_001, 30, true],
    [10_000, 6_999, 30, true],
    [10_000, 7_000, 30, false],
    [null, 50_000, 30, false],
  ])("%s → %s at %s%%", (current, next, percent, sharp) => {
    expect(sharpPriceChange(current, next, percent)).toBe(sharp);
  });
});
