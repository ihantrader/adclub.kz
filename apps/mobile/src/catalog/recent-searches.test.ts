import { describe, expect, it } from "vitest";
import {
  parseRecentSearches,
  RECENT_SEARCHES_MAX,
  rememberSearch,
  tidyQuery,
} from "./recent-searches";

describe("recent searches (M-CAT-04)", () => {
  it("puts the newest first and keeps a query once, whatever its case and spaces", () => {
    let list: string[] = [];
    list = rememberSearch(list, "колодки");
    list = rememberSearch(list, "масло");
    list = rememberSearch(list, "  Колодки ");
    expect(list).toEqual(["Колодки", "масло"]);
  });

  it("keeps at most ten", () => {
    let list: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      list = rememberSearch(list, `запрос ${String(index)}`);
    }
    expect(list).toHaveLength(RECENT_SEARCHES_MAX);
    expect(list[0]).toBe("запрос 14");
    expect(list.at(-1)).toBe("запрос 5");
  });

  it("does not keep a query of one character or of spaces", () => {
    expect(rememberSearch(["масло"], "к")).toEqual(["масло"]);
    expect(rememberSearch(["масло"], "   ")).toEqual(["масло"]);
  });

  it("collapses spaces", () => {
    expect(tidyQuery("  04465   0k090 ")).toBe("04465 0k090");
  });

  it("reads what was stored, and refuses what is not a list", () => {
    expect(parseRecentSearches(["колодки", "масло", "колодки", 5])).toEqual(["колодки", "масло"]);
    expect(parseRecentSearches("колодки")).toBeNull();
    expect(parseRecentSearches(null)).toBeNull();
  });
});
