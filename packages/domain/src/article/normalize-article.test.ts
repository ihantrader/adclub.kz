import { describe, expect, it } from "vitest";
import { normalizeArticle } from "./normalize-article";

describe("normalizeArticle", () => {
  it("uppercases the article", () => {
    expect(normalizeArticle("abc123")).toBe("ABC123");
  });

  it("strips separators so equivalent formats collide", () => {
    expect(normalizeArticle("123-456")).toBe(normalizeArticle("123 456"));
    expect(normalizeArticle("123.456")).toBe(normalizeArticle("123-456"));
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeArticle("  ABC-123  ")).toBe("ABC123");
  });

  it("keeps Cyrillic characters used in some supplier articles", () => {
    expect(normalizeArticle("Аи-92")).toBe("АИ92");
  });

  it("returns an empty string for an article with no significant characters", () => {
    expect(normalizeArticle("   ")).toBe("");
  });
});
