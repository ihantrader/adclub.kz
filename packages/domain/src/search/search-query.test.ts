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
  it("puts the article first, then exact, then partial; in the city, own name, price within", () => {
    const keys = [
      searchRankKey({ match: "partial", own: true, inCity: true, minPrice: 100, id: "a" }),
      searchRankKey({ match: "exact", own: false, inCity: false, minPrice: 50, id: "b" }),
      searchRankKey({ match: "exact", own: true, inCity: false, minPrice: 900, id: "c" }),
      searchRankKey({ match: "exact", own: false, inCity: true, minPrice: 900, id: "d" }),
      searchRankKey({ match: "article", own: false, inCity: false, minPrice: 9000, id: "e" }),
      searchRankKey({ match: "exact", own: false, inCity: false, minPrice: 50, id: "a" }),
    ];
    const order = [...keys].sort(compareSearchRankKeys).map((key) => key[4]);
    expect(order).toEqual(["e", "d", "c", "a", "b", "a"]);
  });
});
