import { describe, expect, it } from "vitest";
import {
  figuresText,
  formulaText,
  listRatingText,
  partText,
  percentText,
  ratingNumber,
  thresholdNumber,
} from "./rating-words";

describe("the words of the rating of a supplier (TASK-050)", () => {
  it("says a rating, «новый» and the shares", () => {
    expect(ratingNumber(4.3)).toBe("4,3");
    expect(ratingNumber(5)).toBe("5,0");
    expect(thresholdNumber(4.35)).toBe("4,35");
    expect(thresholdNumber(3.5)).toBe("3,5");
    expect(listRatingText({ value: 4.3, count: 5, low: false })).toBe("★ 4,3 (5)");
    expect(listRatingText({ value: null, count: 3, low: false })).toBe("новый · оценок 3");
    expect(listRatingText(null)).toBe("новый");
    expect(percentText(0.8)).toBe("80 %");
    expect(percentText(0.996)).toBe("99 %");
    expect(percentText(null)).toBe("мало заявок для оценки");
    expect(partText(45, 50, 0.9, "ответил на")).toBe("ответил на 45 из 50 (90 %)");
  });

  it("names the formula with its weights and version", () => {
    const text = formulaText(
      {
        weights: { reviews: 0.6, response_rate: 0.2, deadline_rate: 0.2 },
        minReviews: 5,
        minOrders: 5,
        windowDays: 180,
      },
      1,
    );
    expect(text).toContain("0,6 × средняя оценка + 0,2 × доля ответов + 0,2 × соблюдение сроков");
    expect(text).toContain("версия формулы 1");
    expect(text).toContain("окно 180 дн.");
  });

  it("says one side of a change of the history", () => {
    expect(
      figuresText({ score: 4.5, isNew: false, reviewsCount: 5, responseRate: 1, onTimeRate: 1 }),
    ).toBe("★ 4,5 (5), ответы 100 %, сроки 100 %");
    expect(
      figuresText({
        score: null,
        isNew: true,
        reviewsCount: 4,
        responseRate: null,
        onTimeRate: 0.5,
      }),
    ).toBe("новый (оценок 4), ответы мало заявок для оценки, сроки 50 %");
  });
});
