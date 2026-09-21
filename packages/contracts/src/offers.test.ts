import { describe, expect, it } from "vitest";
import {
  createOfferBodySchema,
  OFFER_ITEM_SEARCH_MAX_RESULTS,
  offerItemSearchQuerySchema,
  updateOfferBodySchema,
} from "./offers";

describe("the search of an item for an offer", () => {
  it("takes only a query of at least three letters or digits", () => {
    for (const q of ["", "   ", "a", "ab", "a-b", " - 0 . 1 "]) {
      expect(offerItemSearchQuerySchema.safeParse({ q }).success, JSON.stringify(q)).toBe(false);
    }
    for (const q of ["abc", "044 65", "колодки", "0-4-4"]) {
      expect(offerItemSearchQuerySchema.safeParse({ q }).success, q).toBe(true);
    }
    expect(offerItemSearchQuerySchema.safeParse({}).success).toBe(false);
  });

  it("never pages past the first matches", () => {
    expect(offerItemSearchQuerySchema.parse({ q: "abc" })).toMatchObject({ limit: 20, offset: 0 });
    expect(offerItemSearchQuerySchema.safeParse({ q: "abc", limit: "21" }).success).toBe(false);
    expect(
      offerItemSearchQuerySchema.safeParse({
        q: "abc",
        offset: String(OFFER_ITEM_SEARCH_MAX_RESULTS - 20),
        limit: "20",
      }).success,
    ).toBe(true);
    expect(
      offerItemSearchQuerySchema.safeParse({
        q: "abc",
        offset: String(OFFER_ITEM_SEARCH_MAX_RESULTS - 19),
        limit: "20",
      }).success,
    ).toBe(false);
  });
});

describe("an offer's body", () => {
  const offer = {
    itemId: "8a4e2b1c-6d3f-4a5b-9c8d-7e6f5a4b3c2d",
    price: 12_500,
    availability: "in_stock",
    leadDays: 0,
    pickup: true,
    delivery: false,
  };

  it("takes whole tenge and a whole term", () => {
    expect(createOfferBodySchema.safeParse(offer).success).toBe(true);
    expect(createOfferBodySchema.safeParse({ ...offer, price: 12.5 }).success).toBe(false);
    expect(createOfferBodySchema.safeParse({ ...offer, leadDays: 366 }).success).toBe(false);
  });

  it("refuses a change of the item or the status on the field's path", () => {
    const result = updateOfferBodySchema.safeParse({ expectedVersion: 1, itemId: offer.itemId });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["itemId"]);
    expect(updateOfferBodySchema.safeParse({ expectedVersion: 1, price: 100 }).success).toBe(true);
  });
});
