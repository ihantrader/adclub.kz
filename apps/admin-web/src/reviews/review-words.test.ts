import type { AdminComplaint, AdminReview } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  complaintChipCount,
  complaintConflictText,
  holdReasonText,
  holdReasonWords,
  reviewActions,
  reviewConflictText,
  scoreText,
  suggestedRejectReason,
} from "./review-words";

const review = (patch: Partial<AdminReview>): AdminReview => ({
  id: "r",
  version: 2,
  status: "held",
  score: 2,
  text: "текст",
  holdReasons: [],
  rejection: null,
  hidden: null,
  edited: false,
  checkingSince: null,
  publishedAt: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
  order: { id: "o", number: 1028, kind: "stock" },
  supplier: { id: "s", name: "Автомаркет" },
  author: { accountId: "a", name: "Тест Тестов", phone: "+7 701 *** ** 67" },
  ...patch,
});

describe("the words of reviews (TASK-049)", () => {
  it("marks what AI found with [AI]", () => {
    expect(holdReasonText({ kind: "contacts", source: "rule", explanation: "телефон" })).toBe(
      "контакты (телефон)",
    );
    expect(
      holdReasonText({ kind: "profanity", source: "ai", explanation: "Оскорбление продавца" }),
    ).toBe("[AI] мат или оскорбления (Оскорбление продавца)");
    expect(holdReasonText({ kind: "check_unavailable", source: "system", explanation: null })).toBe(
      "проверка недоступна",
    );
  });

  it("offers only the decisions of the status", () => {
    expect(reviewActions("held")).toEqual({
      publish: true,
      rejectText: true,
      hide: false,
      restore: false,
    });
    expect(reviewActions("published")).toMatchObject({ hide: true, publish: false });
    expect(reviewActions("hidden")).toMatchObject({ restore: true, hide: false });
    expect(reviewActions("text_rejected")).toEqual({
      publish: false,
      rejectText: false,
      hide: false,
      restore: false,
    });
  });

  it("suggests the reason of a refusal from what the check found", () => {
    expect(
      suggestedRejectReason(
        review({ holdReasons: [{ kind: "supplier_name", source: "rule", explanation: null }] }),
      ),
    ).toBe("supplier_name");
    expect(
      suggestedRejectReason(
        review({ holdReasons: [{ kind: "threat", source: "ai", explanation: null }] }),
      ),
    ).toBe("profanity");
    expect(suggestedRejectReason(review({}))).toBe("personal_data");
  });

  it("names who decided first in a conflict", () => {
    expect(
      reviewConflictText(
        review({
          status: "text_rejected",
          rejection: {
            reason: "personal_data",
            at: "2026-10-13T10:00:00.000Z",
            by: { adminId: "x", name: "Марат" },
          },
        }),
      ),
    ).toMatch(/^Текст уже отклонил Марат /);
    expect(reviewConflictText(review({ status: "published" }))).toBe(
      "Отзыв уже опубликован. Обновите страницу",
    );
    const complaint = {
      status: "in_progress",
      takenBy: { adminId: "x", name: null },
      takenAt: "2026-10-13T10:00:00.000Z",
      resolvedBy: null,
      resolvedAt: null,
    } as unknown as AdminComplaint;
    expect(complaintConflictText(complaint)).toMatch(
      /^Жалобу уже взял в работу другой администратор /,
    );
  });

  it("draws the score in stars", () => {
    expect(scoreText(4)).toBe("★★★★☆ 4");
    expect(scoreText(1)).toBe("★☆☆☆☆ 1");
  });

  it("says a reason without its source — the row marks AI with its badge (X26)", () => {
    expect(
      holdReasonWords({ kind: "profanity", source: "ai", explanation: "Оскорбление продавца" }),
    ).toBe("мат или оскорбления (Оскорбление продавца)");
    expect(holdReasonWords({ kind: "supplier_name", source: "rule", explanation: null })).toBe(
      "название поставщика",
    );
  });

  it("counts the status chips of complaints from the server's counts", () => {
    const counts = { new: 2, in_progress: 3, resolved: 7 };
    expect(complaintChipCount("open", counts)).toBe(5);
    expect(complaintChipCount("new", counts)).toBe(2);
    expect(complaintChipCount("resolved", counts)).toBe(7);
    expect(complaintChipCount("all", counts)).toBe(12);
    expect(complaintChipCount("all", { new: 1 })).toBe(1);
    expect(complaintChipCount("open", null)).toBeNull();
  });
});
