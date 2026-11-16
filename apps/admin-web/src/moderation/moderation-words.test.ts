import type { AdminModerationEntry } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { locationOf, menuOf } from "../router";
import { shareCell, statsPeriodOf, statsRatingText } from "../suppliers/stats-words";
import { entryHref, entrySub, entryTitle, moderationFiltersOf } from "./moderation-words";

const SUPPLIER = { id: "11111111-1111-4111-8111-111111111111", name: "Автомаркет" };
const ITEM = "22222222-2222-4222-8222-222222222222";

const request: AdminModerationEntry = {
  kind: "item_request",
  id: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-11-16T05:00:00.000Z",
  supplier: SUPPLIER,
  source: "price_import",
  proposed: { name: "Фильтр масляный", brand: "Bosch", article: "F 026 407 210" },
  item: null,
  vehicle: null,
};

const proposal: AdminModerationEntry = {
  kind: "compatibility",
  id: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-11-16T06:00:00.000Z",
  supplier: SUPPLIER,
  source: "cabinet",
  proposed: null,
  item: { id: ITEM, name: "Колодки тормозные", brand: "Geely", article: "04465-0K090" },
  vehicle: "Geely Atlas · II (FX11) · 2023–",
};

describe("«Модерация» — the queue's words", () => {
  it("opens a request's card and the item's «Совместимость»", () => {
    expect(entryHref(request)).toBe(`/catalog/requests/${request.id}`);
    expect(entryHref(proposal)).toBe(`/catalog/items/${ITEM}?tab=compatibility`);
  });

  it("says what is proposed", () => {
    expect(entryTitle(request)).toBe("Фильтр масляный");
    expect(entrySub(request)).toBe("Bosch · F 026 407 210");
    expect(entryTitle(proposal)).toBe("Колодки тормозные");
    expect(entrySub(proposal)).toBe("Geely · 04465-0K090 — Geely Atlas · II (FX11) · 2023–");
  });

  it("reads the filters from the address", () => {
    expect(moderationFiltersOf(new URLSearchParams("kind=compatibility&supplierId=x"))).toEqual({
      kind: "compatibility",
      supplierId: "x",
    });
    expect(moderationFiltersOf(new URLSearchParams("kind=photo"))).toEqual({
      kind: undefined,
      supplierId: undefined,
    });
  });

  it("is a section of its own in the menu", () => {
    expect(locationOf("/moderation").route).toBe("moderation");
    expect(menuOf("moderation")).toBe("moderation");
  });
});

describe("the statistics on the supplier's card", () => {
  it("says the shares and the rating as the cabinet does", () => {
    expect(shareCell(75)).toBe("75 %");
    expect(shareCell(null)).toBe("Мало заявок для оценки");
    expect(statsRatingText(4.6)).toBe("4,6");
    expect(statsRatingText(null)).toBe("Новый поставщик");
    expect(statsPeriodOf(7)).toBe("7");
    expect(statsPeriodOf(null)).toBe("30");
  });
});
