import { describe, expect, it } from "vitest";
import {
  locationOf,
  menuOf,
  offerPath,
  orderPath,
  priceImportPath,
  routeOf,
  tabOf,
} from "./router";

describe("the cabinet's addresses", () => {
  it("maps every page to its address and back, with or without a trailing slash", () => {
    expect(routeOf("/")).toBe("orders");
    expect(routeOf("/team")).toBe("team");
    expect(routeOf("/team/")).toBe("team");
    expect(routeOf("/company")).toBe("company");
    expect(routeOf("/price")).toBe("price");
    expect(routeOf("/showcase")).toBeNull();
  });

  it("keeps the pages of «Ещё» under its tab", () => {
    expect(tabOf("team")).toBe("more");
    expect(tabOf("settings")).toBe("more");
    expect(tabOf("install")).toBe("more");
    expect(tabOf("scan")).toBe("scan");
  });

  it("gives «Прайс» a tab and an upload its own address under it (stage C, TASK-046)", () => {
    const id = "3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
    expect(priceImportPath(id)).toBe(`/price/${id}`);
    expect(locationOf(`/price/${id}`)).toEqual({ route: "priceImport", id });
    expect(routeOf("/price/12")).toBeNull();
    for (const route of ["price", "priceImport"] as const) {
      expect(tabOf(route)).toBe("price");
      expect(menuOf(route)).toBe("price");
    }
  });

  it("gives an offer its own address, under the tab and the menu item «Предложения» (TASK-032)", () => {
    const id = "0b9d4c1e-7a5f-4c39-9f0e-2d6b8a1c3e57";
    expect(offerPath(id)).toBe(`/offers/${id}`);
    expect(locationOf(`/offers/${id}`)).toEqual({ route: "offer", id });
    expect(locationOf(`/offers/${id.toUpperCase()}/`)).toEqual({ route: "offer", id });
    expect(locationOf("/offers/search")).toEqual({ route: "offerSearch", id: null });
    expect(locationOf("/offers/new")).toEqual({ route: "offerNew", id: null });
    // Not an id — not a page.
    expect(routeOf("/offers/123")).toBeNull();
    for (const route of ["offers", "offerSearch", "offerNew", "offer"] as const) {
      expect(tabOf(route)).toBe("offers");
      expect(menuOf(route)).toBe("offers");
    }
    expect(menuOf("more")).toBe("settings");
    expect(menuOf("team")).toBe("team");
  });

  it("puts «Модерация» under «Ещё» and the request for an item under «Предложения» (TASK-048)", () => {
    expect(routeOf("/moderation")).toBe("moderation");
    expect(tabOf("moderation")).toBe("more");
    expect(menuOf("moderation")).toBe("moderation");
    expect(routeOf("/offers/request")).toBe("offerRequest");
    expect(tabOf("offerRequest")).toBe("offers");
    expect(menuOf("offerRequest")).toBe("offers");
  });

  it("gives an order its own address under «Заявки» — the link of W-01 (TASK-033)", () => {
    const id = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
    expect(orderPath(id)).toBe(`/orders/${id}`);
    expect(locationOf(`/orders/${id}`)).toEqual({ route: "order", id });
    expect(locationOf(`/orders/${id.toUpperCase()}/`)).toEqual({ route: "order", id });
    expect(routeOf("/orders/1042")).toBeNull();
    expect(tabOf("order")).toBe("orders");
    expect(menuOf("order")).toBe("orders");
  });
});
