import { describe, expect, it } from "vitest";
import { routeOf, tabOf } from "./router";

describe("the cabinet's addresses", () => {
  it("maps every page to its address and back, with or without a trailing slash", () => {
    expect(routeOf("/")).toBe("orders");
    expect(routeOf("/team")).toBe("team");
    expect(routeOf("/team/")).toBe("team");
    expect(routeOf("/company")).toBe("company");
    expect(routeOf("/price")).toBeNull();
    expect(routeOf("/showcase")).toBeNull();
  });

  it("keeps the pages of «Ещё» under its tab, and has no «Прайс» (stage C)", () => {
    expect(tabOf("team")).toBe("more");
    expect(tabOf("settings")).toBe("more");
    expect(tabOf("install")).toBe("more");
    expect(tabOf("scan")).toBe("scan");
    expect(routeOf("/price")).toBeNull();
  });
});
