import { describe, expect, it } from "vitest";
import {
  daysBetween,
  recommendedScore,
  type RankedOfferFacts,
  type RecommendedWeights,
} from "./offer-ranking";

const weights: RecommendedWeights = { price: 1, receipt: 1, city: 3, verified: 0.5, rating: 0.5 };
const base: RankedOfferFacts = {
  price: 10_000,
  receiptDays: 0,
  inCity: false,
  verified: false,
  rating: null,
};

describe("the «Рекомендуемые» order", () => {
  it("counts calendar days between two dates, across months and years", () => {
    expect(daysBetween("2026-09-22", "2026-09-22")).toBe(0);
    expect(daysBetween("2026-09-30", "2026-10-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-04")).toBe(4);
    expect(daysBetween("2026-10-01", "2026-09-30")).toBe(0);
  });

  it("adds up the parts by their weights", () => {
    // price 1, receipt 1/(1+1) = 0.5, city 1, verified 1, rating 4/5.
    expect(
      recommendedScore(
        { price: 10_000, receiptDays: 1, inCity: true, verified: true, rating: 4 },
        10_000,
        weights,
      ),
    ).toBeCloseTo(1 + 0.5 + 3 + 0.5 + 0.5 * 0.8, 10);
  });

  it("is not the price alone: an offer in the chosen city beats a cheaper one elsewhere", () => {
    const cheaperElsewhere = recommendedScore({ ...base, price: 8_000 }, 8_000, weights);
    const inCity = recommendedScore({ ...base, inCity: true }, 8_000, weights);
    expect(inCity).toBeGreaterThan(cheaperElsewhere);
  });

  it("prefers a sooner date at the same price, and a verified partner", () => {
    const today = recommendedScore(base, 10_000, weights);
    const inThreeDays = recommendedScore({ ...base, receiptDays: 3 }, 10_000, weights);
    const verified = recommendedScore({ ...base, verified: true }, 10_000, weights);
    expect(today).toBeGreaterThan(inThreeDays);
    expect(verified).toBeGreaterThan(today);
  });

  it("follows the weights: with only the price weighted it is the price order", () => {
    const onlyPrice = { price: 1, receipt: 0, city: 0, verified: 0, rating: 0 };
    const dear = recommendedScore({ ...base, price: 20_000, inCity: true }, 10_000, onlyPrice);
    const cheap = recommendedScore({ ...base, receiptDays: 30 }, 10_000, onlyPrice);
    expect(cheap).toBeGreaterThan(dear);
    expect(dear).toBeCloseTo(0.5, 10);
  });

  it("treats a missing rating as zero for everyone", () => {
    const noRating = recommendedScore(base, 10_000, weights);
    const zeroWeight = recommendedScore(base, 10_000, { ...weights, rating: 0 });
    expect(noRating).toBe(zeroWeight);
  });
});
