import { describe, expect, it } from "vitest";
import {
  articleQuery,
  cyrillicToLatin,
  englishLayoutToRussian,
  kazakhLayoutLetters,
  latinToCyrillic,
  matchSearchDocuments,
  normalizeSearchText,
  russianLayoutToEnglish,
  SEARCH_VARIANTS_MAX,
  searchKey,
  searchStems,
  searchVariant,
  searchVariants,
  type SearchDocument,
} from "./search-query";
import { compareSearchRankKeys, searchRankKey } from "./search-ranking";
import { editDistance, searchReading } from "./search-reading";

describe("normalizeSearchText and searchKey (ARCHITECTURE 10.2 п. 1)", () => {
  it.each([
    ["  Тормозные   колодки ", "тормозные колодки", "тормозные колодки"],
    ["Ёлочный ЁЖ", "елочный еж", "елочный еж"],
    ["Масло 5W-30, 4 л", "масло 5w 30 4 л", "масло 5w 30 4 л"],
    ["brake‐pads—front", "brake pads front", "brake pads front"],
    ["ТЕЖЕГІШ ҚАЛЫПТАРЫ", "тежегіш қалыптары", "тежегиш калыптары"],
    ["Әйнек ғ қ ң ө ұ ү һ і", "әйнек ғ қ ң ө ұ ү һ і", "айнек г к н о у у х и"],
    ["«Shell» Helix", "shell helix", "shell helix"],
    ["!!", "", ""],
  ])("%j → text %j, key %j", (input, text, key) => {
    expect(normalizeSearchText(input)).toBe(text);
    expect(searchKey(input)).toBe(key);
  });
});

describe("articleQuery (ARCHITECTURE 10.2 п. 2)", () => {
  it.each([
    ["04465 0k090", "044650K090"],
    ["04465-0K090", "044650K090"],
    ["044650k090", "044650K090"],
    ["04465.0k.090", "044650K090"],
    ["GDB3534", "GDB3534"],
    ["4050068800", "4050068800"],
    ["масло 5w-30", "МАСЛО5W30"],
  ])("%j is the article %j", (input, article) => {
    expect(articleQuery(input)).toBe(article);
  });

  it.each(["колодки", "brake pads", "abc1", "1234", "w-30"])("%j is not an article", (input) => {
    expect(articleQuery(input)).toBeNull();
  });
});

describe("keyboard layouts", () => {
  it.each([
    ["rjkjlrb", "колодки"],
    ["vfckj", "масло"],
    ["ve;crjq", "мужской"],
    ["nhjcbr", "тросик"],
    ["`krf", "ёлка"],
  ])("English keys %j type %j in the Russian layout", (input, output) => {
    expect(englishLayoutToRussian(input)).toBe(output);
  });

  it.each([
    // TASK-044 writes «ыеще»: those keys type «stot»; «stop» is «ыещз».
    ["ыещз", "stop"],
    ["ыеще", "stot"],
    ["икфлу", "brake"],
    ["ырудд", "shell"],
  ])("Russian keys %j type %j in the English layout", (input, output) => {
    expect(russianLayoutToEnglish(input)).toBe(output);
  });

  it.each([
    ["тежег3ш", "тежегіш"],
    ["0алып", "қалып"],
    ["м9най", "мұнай"],
    ["5w-30", "5w-30"],
    ["масло 5w-30", "масло 5w-30"],
  ])("a Kazakh word typed without the Kazakh layout: %j → %j", (input, output) => {
    expect(kazakhLayoutLetters(input)).toBe(output);
  });
});

describe("transliteration", () => {
  it.each([
    ["kolodki", "колодки"],
    ["maslo", "масло"],
    ["shchetka", "щетка"],
    ["toyota", "тойота"],
    ["zhiguli", "жигули"],
  ])("Latin %j → Cyrillic %j", (input, output) => {
    expect(latinToCyrillic(input)).toBe(output);
  });

  it.each([
    ["шелл", "shell"],
    ["мобил", "mobil"],
    ["щётка", "shchetka"],
    ["қалып", "kalyp"],
  ])("Cyrillic %j → Latin %j", (input, output) => {
    expect(cyrillicToLatin(input)).toBe(output);
  });
});

describe("searchStems", () => {
  it.each([
    ["масло", ["масл"]],
    ["тормозные колодки", ["тормозн", "колодк"]],
    ["фильтр", ["фильтр"]],
    ["brake pads", ["brake", "pad"]],
    ["5w 30", ["5w", "30"]],
    ["шина шина", ["шина"]],
  ])("%j → %j", (key, stems) => {
    expect(searchStems(key)).toEqual(stems);
  });
});

describe("searchVariants (ARCHITECTURE 10.2 п. 3)", () => {
  const texts = (query: string) => searchVariants(query).map((variant) => variant.text);

  it("reads a query typed in the English layout as the Russian word", () => {
    expect(texts("rjkjlrb")).toEqual(["rjkjlrb", "колодки", "рджкджлрб"]);
  });

  it("reads a query typed in the Russian layout as the English word", () => {
    expect(texts("ыещз")).toContain("stop");
  });

  it("reads Latin transliteration as Cyrillic", () => {
    expect(texts("kolodki")).toContain("колодки");
  });

  it("reads a Kazakh word typed in the Russian layout", () => {
    expect(texts("тежег3ш")).toContain("тежегіш");
    expect(texts("тежег3ш")[0]).toBe("тежег3ш");
  });

  it("reads a Kazakh word typed in the English layout", () => {
    expect(texts("nt;tu3i")).toContain("тежегіш");
  });

  it("keeps a mixed word that is neither layout as given, with its switched reading", () => {
    const variants = texts("лjkjlrb");
    expect(variants[0]).toBe("лjkjlrb");
    expect(variants).toContain("лолодки");
  });

  it("gives at most four variants without repeats, the query first", () => {
    for (const query of ["лjkjlrb", "brake pads", "колодки", "тежег3ш", "nt;tu3i", "масло 5w-30"]) {
      const variants = searchVariants(query);
      expect(variants.length).toBeLessThanOrEqual(SEARCH_VARIANTS_MAX);
      expect(new Set(variants.map((variant) => variant.key)).size).toBe(variants.length);
      expect(variants[0]?.key).toBe(searchKey(query));
    }
  });

  it("gives nothing for a query of signs only", () => {
    expect(searchVariants("!? ")).toEqual([]);
    expect(searchVariant("--")).toBeNull();
  });
});

describe("matchSearchDocuments", () => {
  const docs = (own: string[], other: string[] = []): SearchDocument[] => [
    ...own.map((text) => ({ key: searchKey(text), own: true })),
    ...other.map((text) => ({ key: searchKey(text), own: false })),
  ];
  const pads = docs(
    ["Колодки тормозные передние", "Алдыңғы тежегіш қалыптары", "Front brake pads"],
    ["Тормозные колодки", "Тежегіш қалыптары", "Brake pads", "колодки", "Geely", "Джили"],
  );

  it.each([
    ["колодки", "exact", false],
    ["brake pads", "exact", false],
    ["тежегіш", "partial", true],
    ["тежегиш калыптары", "exact", false],
    ["тормозные колодки", "exact", false],
    ["колодки передние", "partial", true],
    ["колодки джили", "partial", false],
    ["front pads", "partial", true],
  ])("%j matches the pads: %s, own %s", (query, match, own) => {
    expect(matchSearchDocuments(searchVariants(query), pads)).toMatchObject({ match, own });
  });

  it("says which variant matched", () => {
    expect(matchSearchDocuments(searchVariants("rjkjlrb"), pads)).toMatchObject({
      match: "exact",
      variant: 1,
    });
  });

  it.each(["xyzxyz", "масло", "колодки задние"])("%j does not match the pads", (query) => {
    expect(matchSearchDocuments(searchVariants(query), pads)).toBeNull();
  });

  it("finds «масло» in «масла» by the stem", () => {
    expect(
      matchSearchDocuments(searchVariants("масло"), docs([], ["Моторные масла"])),
    ).toMatchObject({ match: "partial", own: false });
  });
});

describe("searchRankKey (the one order of the search)", () => {
  const facts = { relevance: 0, popularity: 0 };

  it("puts the article first, then exact, then partial; in the city, own name, price within", () => {
    const keys = [
      searchRankKey({
        ...facts,
        match: "partial",
        own: true,
        inCity: true,
        minPrice: 100,
        id: "a",
      }),
      searchRankKey({ ...facts, match: "exact", own: false, inCity: false, minPrice: 50, id: "b" }),
      searchRankKey({ ...facts, match: "exact", own: true, inCity: false, minPrice: 900, id: "c" }),
      searchRankKey({ ...facts, match: "exact", own: false, inCity: true, minPrice: 900, id: "d" }),
      searchRankKey({
        ...facts,
        match: "article",
        own: false,
        inCity: false,
        minPrice: 9000,
        id: "e",
      }),
      searchRankKey({ ...facts, match: "exact", own: false, inCity: false, minPrice: 50, id: "a" }),
    ];
    const order = [...keys].sort(compareSearchRankKeys).map((key) => key[6]);
    expect(order).toEqual(["e", "d", "c", "a", "b", "a"]);
  });

  it("puts what only a typo found last; within a match, the city, then relevance, then popularity", () => {
    const base = { own: true, minPrice: 100 };
    const keys = [
      searchRankKey({
        ...base,
        match: "typo",
        inCity: true,
        relevance: 0.99,
        popularity: 50,
        id: "t",
      }),
      searchRankKey({
        ...base,
        match: "partial",
        inCity: false,
        relevance: 0.9,
        popularity: 0,
        id: "o",
      }),
      searchRankKey({
        ...base,
        match: "partial",
        inCity: true,
        relevance: 0.5,
        popularity: 0,
        id: "c",
      }),
      searchRankKey({
        ...base,
        match: "partial",
        inCity: true,
        relevance: 0.8,
        popularity: 1,
        id: "r",
      }),
      searchRankKey({
        ...base,
        match: "partial",
        inCity: true,
        relevance: 0.8,
        popularity: 9,
        id: "p",
      }),
    ];
    const order = [...keys].sort(compareSearchRankKeys).map((key) => key[6]);
    expect(order).toEqual(["p", "r", "c", "o", "t"]);
  });

  it("does not tell apart relevances closer than the fourth decimal", () => {
    const a = searchRankKey({
      match: "exact",
      inCity: true,
      relevance: 0.912345,
      popularity: 0,
      own: true,
      minPrice: 10,
      id: "b",
    });
    const b = searchRankKey({
      match: "exact",
      inCity: true,
      relevance: 0.912349,
      popularity: 0,
      own: true,
      minPrice: 10,
      id: "a",
    });
    expect(compareSearchRankKeys(b, a)).toBeLessThan(0);
  });
});

describe("searchReading (T-CAT-08 when a typo was forgiven)", () => {
  const read = (query: string, texts: string[]) =>
    searchReading(searchVariants(query)[0]!, texts).text;
  const kept = (query: string, texts: string[]) =>
    searchReading(searchVariants(query)[0]!, texts).kept;

  it("counts the words kept: none — not really found", () => {
    expect(kept("зимние шины", ["Колодки тормозные задние", "Rear brake pads"])).toBe(0);
    expect(kept("масло для coolray", ["Моторные масла", "Shell Helix HX8 5W-30, 4 л"])).toBe(1);
    expect(kept("колодки geely atlas", ["Колодки тормозные передние", "Geely"])).toBe(2);
  });

  it("corrects a typo to the word of the found texts", () => {
    expect(read("колодкм", ["Колодки тормозные передние"])).toBe("колодки");
    expect(read("тормозные колодкм", ["Колодки тормозные передние"])).toBe("тормозные колодки");
  });

  it("keeps words that begin a word, Kazakh letters as the text has them", () => {
    expect(read("тежегиш калыптарм", ["Алдыңғы тежегіш қалыптары"])).toBe("тежегиш қалыптары");
    expect(read("масло shell", ["Shell Helix HX8 5W-30, 4 л", "Моторные масла", "масло"])).toBe(
      "масло shell",
    );
  });

  it("keeps a word the texts have in two («5w30» — «5W-30»)", () => {
    expect(read("масло 5w30", ["Mobil 1 ESP 5W-30", "Моторные масла", "масло"])).toBe("масло 5w30");
  });

  it("leaves out a word nothing is near, and never corrects a short word", () => {
    expect(read("колодки атлас", ["Колодки тормозные передние"])).toBe("колодки");
    expect(read("hlx", ["Shell Helix HX8"])).toBe("hlx");
  });

  it("measures transpositions as one edit", () => {
    expect(editDistance("колодик", "колодки")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "ab")).toBe(2);
  });
});
