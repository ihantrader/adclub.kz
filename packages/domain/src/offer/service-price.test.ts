import { describe, expect, it } from "vitest";
import {
  lowestServicePrice,
  servicePriceForCar,
  supplierOffers,
  type ServicePricing,
} from "./service-price";

const COOLRAY = "11111111-1111-4111-8111-111111111111";
const ATLAS = "22222222-2222-4222-8222-222222222222";
const MONJARO = "33333333-3333-4333-8333-333333333333";
const TUGELLA = "44444444-4444-4444-8444-444444444444";

const byModel: ServicePricing = {
  mode: "by_model",
  prices: [
    { modelId: COOLRAY, price: 8_000, available: true },
    { modelId: ATLAS, price: 10_000, available: true },
    { modelId: TUGELLA, price: 15_000, available: false },
  ],
};

describe("servicePriceForCar", () => {
  it.each([
    ["one price, any model", { mode: "single", price: 7_000 } as const, COOLRAY, 7_000],
    ["one price, no model known", { mode: "single", price: 7_000 } as const, null, 7_000],
    ["by model, Coolray", byModel, COOLRAY, 8_000],
    ["by model, Atlas", byModel, ATLAS, 10_000],
    ["by model, a model without a price", byModel, MONJARO, null],
    ["by model, a model in the archive", byModel, TUGELLA, null],
    ["by model, no model known", byModel, null, null],
  ])("%s", (_case, pricing, modelId, expected) => {
    expect(servicePriceForCar(pricing, { modelId })).toBe(expected);
  });

  it("without a car only one price for all fits", () => {
    expect(servicePriceForCar({ mode: "single", price: 5_000 }, null)).toBe(5_000);
    expect(servicePriceForCar(byModel, null)).toBeNull();
  });
});

describe("lowestServicePrice", () => {
  it("is the price itself, or the lowest model price", () => {
    expect(lowestServicePrice({ mode: "single", price: 5_000 })).toBe(5_000);
    expect(lowestServicePrice(byModel)).toBe(8_000);
    expect(lowestServicePrice({ mode: "by_model", prices: [] })).toBeNull();
  });
});

describe("supplierOffers", () => {
  it.each([
    ["goods", "part", true],
    ["goods", "generic", true],
    ["goods", "service", false],
    ["services", "part", false],
    ["services", "generic", false],
    ["services", "service", true],
    ["both", "part", true],
    ["both", "service", true],
  ] as const)("a supplier of %s and an item of %s — %s", (supplierType, itemType, expected) => {
    expect(supplierOffers(supplierType, itemType)).toBe(expected);
  });
});
