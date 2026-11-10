import type { PartPhotoResponse } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { partPhotoOutcome, stillRecognizedArticle } from "./part-photo";

const attempts = { scope: "guest" as const, remaining: 1, limit: 3 };

function answer(overrides: Partial<PartPhotoResponse> = {}): PartPhotoResponse {
  return {
    kind: "article_found",
    article: { text: "GDB3534", normalized: "GDB3534", confidence: 0.95 },
    candidates: [{ text: "04465-0K090", normalized: "044650K090", confidence: 0.8 }],
    brandHint: "TRW",
    items: [],
    total: 1,
    empty: null,
    analogs: [],
    attempts,
    ...overrides,
  };
}

describe("a part by its photo (TASK-058)", () => {
  it("puts the article into the search line and the others into chips", () => {
    expect(partPhotoOutcome(answer())).toEqual({
      kind: "found",
      found: { article: "GDB3534", candidates: ["04465-0K090"], analogs: [], total: 1 },
    });
  });

  it("says «Не нашли артикул на фото» for no article and for nothing readable", () => {
    for (const kind of ["no_article", "unreadable"] as const) {
      expect(partPhotoOutcome(answer({ kind, article: null, candidates: [] }))).toEqual({
        kind: "not_found",
      });
    }
  });

  it("keeps «распознан» only while the line holds the article", () => {
    expect(stillRecognizedArticle("04465-0K090", "04465-0K090")).toBe(true);
    expect(stillRecognizedArticle(" 04465-0K090 ", "04465-0K090")).toBe(true);
    expect(stillRecognizedArticle("04465-0K09", "04465-0K090")).toBe(false);
    expect(stillRecognizedArticle("04465-0K090", null)).toBe(false);
  });
});
