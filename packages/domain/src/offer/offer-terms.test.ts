import { describe, expect, it } from "vitest";
import { offerTermsProblem, type OfferTerms } from "./offer-terms";

const limits = { priceMin: 100, priceMax: 10_000_000, leadDaysMax: 90 };
const goods: OfferTerms = {
  availability: "in_stock",
  leadDays: 0,
  pickup: true,
  delivery: false,
  warrantyMonths: null,
  warrantyText: null,
};
const facts = { service: false, limits, pickupNeedsAddress: false };

describe("offerTermsProblem", () => {
  it("passes good terms", () => {
    expect(offerTermsProblem(12_500, goods, facts)).toBeNull();
  });

  it("checks the price first, then the term", () => {
    expect(offerTermsProblem(50, { ...goods, leadDays: 200 }, facts)).toEqual({
      code: "price_out_of_range",
      min: 100,
      max: 10_000_000,
    });
    expect(offerTermsProblem(500, { ...goods, leadDays: 200 }, facts)).toEqual({
      code: "lead_days_out_of_range",
      min: 0,
      max: 90,
    });
  });

  it("needs a term for an offer under order", () => {
    expect(offerTermsProblem(500, { ...goods, availability: "on_order" }, facts)).toEqual({
      code: "on_order_needs_lead_days",
    });
    expect(
      offerTermsProblem(500, { ...goods, availability: "on_order", leadDays: 3 }, facts),
    ).toBeNull();
  });

  it("needs pickup or delivery for goods, not for a service", () => {
    const none = { ...goods, pickup: false, delivery: false };
    expect(offerTermsProblem(500, none, facts)).toEqual({ code: "no_fulfillment" });
    expect(offerTermsProblem(500, none, { ...facts, service: true })).toBeNull();
  });

  it("refuses the warranty twice and contacts in it", () => {
    expect(
      offerTermsProblem(500, { ...goods, warrantyMonths: 6, warrantyText: "по чеку" }, facts),
    ).toEqual({ code: "warranty_both" });
    expect(
      offerTermsProblem(500, { ...goods, warrantyText: "звоните +7 705 555 01 01" }, facts),
    ).toEqual({ code: "warranty_contacts", found: ["phone"] });
  });

  it("refuses pickup at a point without an address last", () => {
    expect(offerTermsProblem(500, goods, { ...facts, pickupNeedsAddress: true })).toEqual({
      code: "pickup_needs_address",
    });
  });
});
