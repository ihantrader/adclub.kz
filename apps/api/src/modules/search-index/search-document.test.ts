import { describe, expect, it } from "vitest";
import {
  documentHash,
  searchIndexSettings,
  synonymMap,
  synonymsHash,
  type SearchIndexDocumentContent,
} from "./search-document";

const content: SearchIndexDocumentContent = {
  id: "a",
  kind: "goods",
  categoryId: "c",
  nodeId: "n",
  article: ["044650k090", "04465 0k090"],
  own: ["колодки тормозные передние"],
  brand: ["geely"],
  category: ["тормозные колодки", "колодки"],
  values: ["передняя"],
  cities: ["x", "y"],
  popularity: 3,
};

describe("the synonyms of the index (ARCHITECTURE 10.2 п. 4)", () => {
  it("makes every term of a group stand for every other", () => {
    expect(synonymMap([["колодки", "тормозные колодки", "brake pads"]])).toEqual({
      "brake pads": ["колодки", "тормозные колодки"],
      колодки: ["brake pads", "тормозные колодки"],
      "тормозные колодки": ["brake pads", "колодки"],
    });
  });

  it("joins the groups a term is in, and leaves out empty, long and lonely terms", () => {
    const map = synonymMap([
      ["масло", "моторные масла"],
      ["масло", "engine oil", ""],
      ["одно"],
      ["a b c d e f", "короткий", "второй"],
    ]);
    expect(map["масло"]).toEqual(["engine oil", "моторные масла"]);
    expect(map["одно"]).toBeUndefined();
    expect(map["a b c d e f"]).toBeUndefined();
    expect(map["короткий"]).toEqual(["второй"]);
    expect(Object.keys(map)).not.toContain("");
  });

  it("hashes the same synonyms the same way, whatever the order of the groups", () => {
    expect(
      synonymsHash(
        synonymMap([
          ["a", "b"],
          ["c", "d"],
        ]),
      ),
    ).toBe(
      synonymsHash(
        synonymMap([
          ["d", "c"],
          ["b", "a"],
        ]),
      ),
    );
  });
});

describe("the hash of a document (the nightly check)", () => {
  it("does not depend on the order of the values, nor on popularity", () => {
    expect(documentHash(content)).toBe(
      documentHash({
        ...content,
        article: [...content.article].reverse(),
        cities: ["y", "x"],
        popularity: 99,
      }),
    );
  });

  it("changes with the texts, the cities or the category", () => {
    const hash = documentHash(content);
    expect(documentHash({ ...content, own: ["другое"] })).not.toBe(hash);
    expect(documentHash({ ...content, cities: ["x"] })).not.toBe(hash);
    expect(documentHash({ ...content, categoryId: "d" })).not.toBe(hash);
  });
});

describe("the settings of the index", () => {
  it("searches the article first, forgives no typo in it and ranks by popularity last", () => {
    const settings = searchIndexSettings({}) as {
      searchableAttributes: string[];
      rankingRules: string[];
      typoTolerance: { disableOnAttributes: string[] };
      filterableAttributes: string[];
    };
    expect(settings.searchableAttributes[0]).toBe("article");
    expect(settings.typoTolerance.disableOnAttributes).toEqual(["article"]);
    expect(settings.rankingRules.at(-1)).toBe("popularity:desc");
    expect(settings.filterableAttributes).toContain("cities");
  });
});
