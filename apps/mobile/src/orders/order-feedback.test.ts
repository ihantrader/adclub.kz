import { ApiError, type ApiErrorCode } from "@adclub/api-client";
import { complaintReasonSchema, type UserOrderReview } from "@adclub/contracts";
import { mobileText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import {
  complaintCanSend,
  complaintFailure,
  complaintFailureKeys,
  complaintReasonKeys,
  initialComplaintReason,
  leavesForm,
  orderFeedback,
  rejectReasonKeys,
  reviewCanSend,
  reviewFailure,
  reviewFailureKeys,
  sentText,
  type OrderFeedbackInput,
} from "./order-feedback";

const ALL_REASONS = complaintReasonSchema.options;
const AFTER_ACCEPT = ALL_REASONS.filter((reason) => reason !== "not_received");

function review(overrides: Partial<UserOrderReview> = {}): UserOrderReview {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    score: 2,
    text: "долго ждал ответа",
    status: "checking",
    rejection: null,
    canEditText: false,
    canPublishScoreOnly: false,
    createdAt: "2026-10-14T08:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Partial<OrderFeedbackInput> = {}): OrderFeedbackInput {
  return {
    canReview: false,
    review: null,
    complaint: null,
    complaintReasons: [],
    reviewUnavailable: null,
    ...overrides,
  };
}

function apiError(code: ApiErrorCode, status: number, details?: unknown): ApiError {
  return new ApiError({ status, code, message: "refused", details, retryable: false });
}

describe("orderFeedback (M-ORD-03 blocks and actions)", () => {
  it("shows nothing for an order of the saved copy", () => {
    expect(orderFeedback(null)).toEqual({
      review: null,
      rate: false,
      testOrder: false,
      complaint: null,
      complain: false,
      notReceived: false,
    });
  });

  it("offers «Оценить», «Пожаловаться» and T-ORD-08 for an order given out", () => {
    const view = orderFeedback(order({ canReview: true, complaintReasons: ALL_REASONS }));
    expect(view).toMatchObject({ rate: true, testOrder: false, complain: true, notReceived: true });
  });

  it("offers a complaint without T-ORD-08 for an accepted order (the server's reasons)", () => {
    const view = orderFeedback(order({ complaintReasons: AFTER_ACCEPT }));
    expect(view).toMatchObject({ rate: false, complain: true, notReceived: false });
  });

  it("says «тестовый заказ» only when the server says so, in place of the button", () => {
    expect(orderFeedback(order({ reviewUnavailable: "test_order" }))).toMatchObject({
      rate: false,
      testOrder: true,
    });
    // Not given out (the server says nothing): no line at all.
    expect(orderFeedback(order())).toMatchObject({ rate: false, testOrder: false });
  });

  it("shows a review as its author sees it and no second «Оценить»", () => {
    expect(orderFeedback(order({ canReview: true, review: review() })).rate).toBe(false);
    expect(orderFeedback(order({ review: review() })).review).toEqual({
      kind: "checking",
      score: 2,
      text: "долго ждал ответа",
    });
    expect(orderFeedback(order({ review: review({ status: "published" }) })).review).toEqual({
      kind: "published",
      score: 2,
      text: "долго ждал ответа",
    });
  });

  it("gives T-REV-02 its reason and only the actions the server allows", () => {
    const first = orderFeedback(
      order({
        review: review({
          status: "text_rejected",
          rejection: { reason: "supplier_name" },
          canEditText: true,
          canPublishScoreOnly: true,
        }),
      }),
    ).review;
    expect(first).toEqual({
      kind: "rejected",
      score: 2,
      text: "долго ждал ответа",
      reason: "supplier_name",
      canEditText: true,
      canPublishScoreOnly: true,
    });
    // The corrected text refused again: only «Опубликовать только оценку».
    const again = orderFeedback(
      order({
        review: review({
          status: "text_rejected",
          rejection: { reason: "profanity" },
          canEditText: false,
          canPublishScoreOnly: true,
        }),
      }),
    ).review;
    expect(again).toMatchObject({
      kind: "rejected",
      canEditText: false,
      canPublishScoreOnly: true,
    });
  });

  it("shows the complaint and hides «Пожаловаться» while it is open (no reasons from the server)", () => {
    const open = orderFeedback(
      order({
        complaint: {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          reason: "not_received",
          status: "in_review",
          createdAt: "2026-10-14T08:00:00.000Z",
          resolvedAt: null,
        },
        complaintReasons: [],
      }),
    );
    expect(open).toMatchObject({
      complaint: { status: "in_review", reason: "not_received" },
      complain: false,
      notReceived: false,
    });
    // Resolved: the server gives the reasons again.
    const resolved = orderFeedback(
      order({
        complaint: {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          reason: "not_received",
          status: "resolved",
          createdAt: "2026-10-14T08:00:00.000Z",
          resolvedAt: "2026-10-14T09:00:00.000Z",
        },
        complaintReasons: ALL_REASONS,
      }),
    );
    expect(resolved).toMatchObject({ complaint: { status: "resolved" }, complain: true });
  });
});

describe("the forms (M-ORD-05, M-ORD-06)", () => {
  it("sends a review only with a score, the text within the limit", () => {
    const form = { mode: "new" as const, score: null, text: "", maxLength: 10 };
    expect(reviewCanSend(form)).toBe(false);
    expect(reviewCanSend({ ...form, score: 4 })).toBe(true);
    expect(reviewCanSend({ ...form, score: 4, text: "a".repeat(10) })).toBe(true);
    expect(reviewCanSend({ ...form, score: 4, text: "a".repeat(11) })).toBe(false);
    expect(reviewCanSend({ ...form, score: 6 })).toBe(false);
  });

  it("needs a text to correct it (the score stays)", () => {
    const form = { mode: "edit" as const, score: 2, text: "  ", maxLength: 100 };
    expect(reviewCanSend(form)).toBe(false);
    expect(reviewCanSend({ ...form, text: "без названия" })).toBe(true);
  });

  it("sends a complaint with an allowed reason; «Другое» needs a text", () => {
    const form = { reason: null, allowed: ALL_REASONS, text: "", maxLength: 20 };
    expect(complaintCanSend(form)).toBe(false);
    expect(complaintCanSend({ ...form, reason: "price_higher" })).toBe(true);
    expect(complaintCanSend({ ...form, reason: "other" })).toBe(false);
    expect(complaintCanSend({ ...form, reason: "other", text: "  " })).toBe(false);
    expect(complaintCanSend({ ...form, reason: "other", text: "не отвечает" })).toBe(true);
    expect(complaintCanSend({ ...form, reason: "other", text: "a".repeat(21) })).toBe(false);
    // A reason the server does not allow now is not sent.
    expect(complaintCanSend({ ...form, allowed: AFTER_ACCEPT, reason: "not_received" })).toBe(
      false,
    );
  });

  it("opens T-ORD-08 with «Не получил…» only if the server allows it", () => {
    expect(initialComplaintReason("not_received", ALL_REASONS)).toBe("not_received");
    expect(initialComplaintReason("not_received", AFTER_ACCEPT)).toBeNull();
    expect(initialComplaintReason(undefined, ALL_REASONS)).toBeNull();
  });

  it("sends a blank text as none", () => {
    expect(sentText(" \n ")).toBeNull();
    expect(sentText("ок")).toBe("ок");
  });
});

describe("the refusals in words", () => {
  it("tells the refusals of a review apart", () => {
    expect(reviewFailure(apiError("REVIEW_EXISTS", 409, { reviewId: "x" }))).toEqual({
      kind: "exists",
    });
    expect(reviewFailure(apiError("REVIEW_NOT_ALLOWED", 409, { reason: "test_order" }))).toEqual({
      kind: "test_order",
    });
    expect(reviewFailure(apiError("REVIEW_NOT_ALLOWED", 409, { reason: "not_completed" }))).toEqual(
      { kind: "not_completed" },
    );
    expect(reviewFailure(apiError("REVIEW_STATE", 409, { reason: "edit_used" }))).toEqual({
      kind: "edit_used",
    });
    expect(reviewFailure(apiError("REVIEW_STATE", 409, { reason: "not_rejected" }))).toEqual({
      kind: "not_rejected",
    });
    expect(
      reviewFailure(apiError("VALIDATION_ERROR", 400, [{ path: "text", message: "At most 100" }])),
    ).toEqual({ kind: "too_long" });
    expect(reviewFailure(apiError("RATE_LIMITED", 429, { retryAfterSeconds: 125 }))).toEqual({
      kind: "rate_limited",
      minutes: 3,
    });
    expect(reviewFailure(apiError("NETWORK_ERROR", 0))).toEqual({ kind: "network" });
    expect(reviewFailure(apiError("INTERNAL_ERROR", 500))).toEqual({ kind: "network" });
    expect(reviewFailure(apiError("SESSION_ENDED", 401))).toEqual({ kind: "session_ended" });
    expect(reviewFailure(apiError("NOT_FOUND", 404))).toEqual({ kind: "not_found" });
    expect(reviewFailure(new Error("boom"))).toEqual({ kind: "other" });
  });

  it("tells the refusals of a complaint apart", () => {
    const sent = { reason: "price_higher" as const, text: null };
    expect(complaintFailure(apiError("COMPLAINT_EXISTS", 409, { complaintId: "x" }), sent)).toEqual(
      { kind: "exists" },
    );
    expect(
      complaintFailure(
        apiError("COMPLAINT_NOT_ALLOWED", 409, { reason: "order_not_accepted" }),
        sent,
      ),
    ).toEqual({ kind: "order_not_accepted" });
    expect(
      complaintFailure(
        apiError("COMPLAINT_NOT_ALLOWED", 409, { reason: "not_received_requires_completed" }),
        { reason: "not_received", text: null },
      ),
    ).toEqual({ kind: "not_received_requires_completed" });
    const textRefused = apiError("VALIDATION_ERROR", 400, [{ path: "text", message: "?" }]);
    expect(complaintFailure(textRefused, { reason: "other", text: null })).toEqual({
      kind: "text_required",
    });
    expect(complaintFailure(textRefused, { reason: "other", text: "очень длинно" })).toEqual({
      kind: "too_long",
    });
    expect(complaintFailure(apiError("RATE_LIMITED", 429, {}), sent)).toEqual({
      kind: "rate_limited",
      minutes: 1,
    });
    expect(complaintFailure(apiError("SERVICE_UNAVAILABLE", 503), sent)).toEqual({
      kind: "network",
    });
  });

  it("leaves the form when there is nothing more to send, stays when it may be sent again", () => {
    expect(leavesForm({ kind: "exists" })).toBe(true);
    expect(leavesForm({ kind: "edit_used" })).toBe(true);
    expect(leavesForm({ kind: "network" })).toBe(false);
    expect(leavesForm({ kind: "rate_limited", minutes: 1 })).toBe(false);
    expect(leavesForm({ kind: "text_required" })).toBe(false);
  });

  it("has words in kk, ru and en for every reason and refusal", () => {
    const keys = [
      ...Object.values(rejectReasonKeys),
      ...Object.values(complaintReasonKeys),
      ...Object.values(reviewFailureKeys),
      ...Object.values(complaintFailureKeys),
    ];
    for (const lang of ["kk", "ru", "en"] as const) {
      for (const key of keys) {
        expect(mobileText(lang, key).trim(), `${lang} ${key}`).not.toBe("");
      }
    }
  });

  it("uses the SCREENS words for the reasons", () => {
    expect(Object.values(rejectReasonKeys).map((key) => mobileText("ru", key))).toEqual([
      "мат или оскорбления",
      "личные данные",
      "название поставщика",
      "реклама или ссылки",
    ]);
    expect(Object.values(complaintReasonKeys).map((key) => mobileText("ru", key))).toEqual([
      "Не получил товар или услугу",
      "Товар не соответствует",
      "Цена выше клубной",
      "Поставщик не выходил на связь",
      "Другое",
    ]);
  });
});
