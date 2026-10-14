import { isApiError } from "@adclub/api-client";
import type {
  ComplaintReasonValue,
  ReviewRejectReason,
  UserOrderComplaint,
  UserOrderReview,
} from "@adclub/contracts";

/**
 * Reviews and complaints on the order screen (TASK-049.B; SCREENS M-ORD-03,
 * M-ORD-05, M-ORD-06) without React Native: what the order says of its
 * review and complaint, which buttons are drawn, the reasons in words and
 * what a refusal of the server says. Everything here is read from what the
 * server answered (`UserOrder`): whether an order may be reviewed, which
 * reasons a complaint may take now, what the author sees of a review — the
 * app decides none of it (ARCHITECTURE 4.69, 4.70).
 */

/** The part of `UserOrder` this needs; an order from the saved copy has none of it. */
export interface OrderFeedbackInput {
  canReview: boolean;
  review: UserOrderReview | null;
  complaint: UserOrderComplaint | null;
  complaintReasons: readonly ComplaintReasonValue[];
  reviewUnavailable: "test_order" | null;
}

/** The block of the review on the order, by its status as its author sees it (I742). */
export type ReviewBlock =
  /** «Отзыв на проверке»: the check or the administrator decides. */
  | { kind: "checking"; score: number; text: string | null }
  /** «Отзыв опубликован» (a review the administrator hid is said so too). */
  | { kind: "published"; score: number; text: string | null }
  /**
   * T-REV-02 «Отзыв не опубликован: {причина}…» with «Исправить текст» (once)
   * and «Опубликовать только оценку» — each only if the server allows it.
   */
  | {
      kind: "rejected";
      score: number;
      text: string | null;
      reason: ReviewRejectReason | null;
      canEditText: boolean;
      canPublishScoreOnly: boolean;
    };

export interface FeedbackView {
  review: ReviewBlock | null;
  /** «Оценить поставщика». */
  rate: boolean;
  /** «Отзыв недоступен: это тестовый заказ» in place of the button. */
  testOrder: boolean;
  /** «Жалоба на рассмотрении» / «Жалоба рассмотрена» with its reason. */
  complaint: { status: "in_review" | "resolved"; reason: ComplaintReasonValue } | null;
  /** «Пожаловаться»: the server gave reasons a complaint may take now. */
  complain: boolean;
  /** T-ORD-08 «Не получали товар? Сообщите нам» → M-ORD-06 with «Не получил…» chosen. */
  notReceived: boolean;
}

const NOTHING: FeedbackView = {
  review: null,
  rate: false,
  testOrder: false,
  complaint: null,
  complain: false,
  notReceived: false,
};

/** What the order screen shows of the review and the complaint; `null` input — the copy, nothing. */
export function orderFeedback(order: OrderFeedbackInput | null): FeedbackView {
  if (!order) return NOTHING;
  const { review } = order;
  return {
    review: review ? reviewBlock(review) : null,
    rate: order.canReview && review === null,
    testOrder: !order.canReview && review === null && order.reviewUnavailable === "test_order",
    complaint: order.complaint
      ? { status: order.complaint.status, reason: order.complaint.reason }
      : null,
    complain: order.complaintReasons.length > 0,
    notReceived: order.complaintReasons.includes("not_received"),
  };
}

function reviewBlock(review: UserOrderReview): ReviewBlock {
  const base = { score: review.score, text: review.text };
  if (review.status === "text_rejected") {
    return {
      kind: "rejected",
      ...base,
      reason: review.rejection?.reason ?? null,
      canEditText: review.canEditText,
      canPublishScoreOnly: review.canPublishScoreOnly,
    };
  }
  return { kind: review.status, ...base };
}

// --------------------------------------------------------------- the words

/** T-REV-02 {причина} (SCREENS M-ORD-05): «мат или оскорбления», «личные данные»… */
export const rejectReasonKeys = {
  profanity: "review.reason.profanity",
  personal_data: "review.reason.personalData",
  supplier_name: "review.reason.supplierName",
  advertising: "review.reason.advertising",
} as const satisfies Record<ReviewRejectReason, string>;

/** M-ORD-06: «Не получил товар или услугу» / «Товар не соответствует» / … */
export const complaintReasonKeys = {
  not_received: "complaint.reason.notReceived",
  not_as_described: "complaint.reason.notAsDescribed",
  price_higher: "complaint.reason.priceHigher",
  no_contact: "complaint.reason.noContact",
  other: "complaint.reason.other",
} as const satisfies Record<ComplaintReasonValue, string>;

// ---------------------------------------------------------------- the forms

/**
 * M-ORD-05: «Отправить» needs a score; the text is free but within the
 * server's limit. «Исправить текст» (`edit`) keeps the score and needs a text
 * — the server refuses an empty one.
 */
export function reviewCanSend(form: {
  mode: "new" | "edit";
  score: number | null;
  text: string;
  maxLength: number;
}): boolean {
  if (form.text.length > form.maxLength) return false;
  if (form.mode === "edit") return form.text.trim().length >= 3;
  return form.score !== null && form.score >= 1 && form.score <= 5;
}

/** M-ORD-06: a reason the server allows now; «Другое» needs a text. */
export function complaintCanSend(form: {
  reason: ComplaintReasonValue | null;
  allowed: readonly ComplaintReasonValue[];
  text: string;
  maxLength: number;
}): boolean {
  if (form.reason === null || !form.allowed.includes(form.reason)) return false;
  if (form.text.length > form.maxLength) return false;
  return form.reason !== "other" || form.text.trim() !== "";
}

/**
 * The reason chosen when the screen opens: the one asked for (T-ORD-08 asks
 * for «Не получил…») if the server allows it now, otherwise none.
 */
export function initialComplaintReason(
  asked: ComplaintReasonValue | undefined,
  allowed: readonly ComplaintReasonValue[],
): ComplaintReasonValue | null {
  return asked !== undefined && allowed.includes(asked) ? asked : null;
}

/** A text the server keeps: blank is no text. */
export function sentText(text: string): string | null {
  return text.trim() === "" ? null : text;
}

// ------------------------------------------------------------- the refusals

/** What the review screen does with an answer that is not a review. */
export type ReviewFailure =
  /** The order has a review already (another device): back to the order, which shows it. */
  | { kind: "exists" }
  | { kind: "test_order" }
  /** The order is not given out (any more). */
  | { kind: "not_completed" }
  /** «Исправить текст» was used already. */
  | { kind: "edit_used" }
  /** The text is no longer refused (the administrator decided meanwhile). */
  | { kind: "not_rejected" }
  | { kind: "rate_limited"; minutes: number }
  /** Longer than the server takes now (the setting was lowered). */
  | { kind: "too_long" }
  /** The order or the review is not the user's one any more. */
  | { kind: "not_found" }
  | { kind: "session_ended" }
  /** No answer, or the server failed: «Повторить» sends the same key. */
  | { kind: "network" }
  | { kind: "other" };

/** What the complaint screen does with an answer that is not a complaint. */
export type ComplaintFailure =
  /** A complaint about the order is open already: back to the order. */
  | { kind: "exists" }
  /** The order still waits for an answer of the supplier. */
  | { kind: "order_not_accepted" }
  /** «Не получил…» is about an order given out. */
  | { kind: "not_received_requires_completed" }
  | { kind: "rate_limited"; minutes: number }
  | { kind: "too_long" }
  /** «Другое» without a text. */
  | { kind: "text_required" }
  | { kind: "not_found" }
  | { kind: "session_ended" }
  | { kind: "network" }
  | { kind: "other" };

type CommonFailure =
  | { kind: "rate_limited"; minutes: number }
  | { kind: "not_found" }
  | { kind: "session_ended" }
  | { kind: "network" }
  | { kind: "other" };

function reasonOf(error: unknown): unknown {
  if (!isApiError(error)) return undefined;
  const { details } = error;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as { reason?: unknown }).reason
    : undefined;
}

function validationPaths(error: unknown): string[] {
  if (!isApiError(error) || !Array.isArray(error.details)) return [];
  return (error.details as unknown[]).map((entry) =>
    typeof entry === "object" && entry !== null
      ? String((entry as { path?: unknown }).path ?? "")
      : "",
  );
}

function commonFailure(error: unknown): CommonFailure {
  if (!isApiError(error)) return { kind: "other" };
  switch (error.code) {
    case "RATE_LIMITED": {
      const details = (error.details ?? {}) as { retryAfterSeconds?: unknown };
      const seconds = Number(details.retryAfterSeconds);
      return {
        kind: "rate_limited",
        minutes: Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60)),
      };
    }
    case "NOT_FOUND":
      return { kind: "not_found" };
    case "SESSION_ENDED":
    case "AUTH_REQUIRED":
    case "ACCESS_TOKEN_EXPIRED":
      return { kind: "session_ended" };
    case "NETWORK_ERROR":
    case "SERVICE_UNAVAILABLE":
    case "INTERNAL_ERROR":
    case "INVALID_RESPONSE":
      return { kind: "network" };
    default:
      return error.status >= 500 ? { kind: "network" } : { kind: "other" };
  }
}

export function reviewFailure(error: unknown): ReviewFailure {
  if (isApiError(error)) {
    const reason = reasonOf(error);
    switch (error.code) {
      case "REVIEW_EXISTS":
        return { kind: "exists" };
      case "REVIEW_NOT_ALLOWED":
        return reason === "test_order" ? { kind: "test_order" } : { kind: "not_completed" };
      case "REVIEW_STATE":
        return reason === "edit_used" ? { kind: "edit_used" } : { kind: "not_rejected" };
      case "VALIDATION_ERROR":
        return validationPaths(error).includes("text") ? { kind: "too_long" } : { kind: "other" };
    }
  }
  return commonFailure(error);
}

/** `sent` — what was sent: a refused text of «Другое» that was blank is a missing one. */
export function complaintFailure(
  error: unknown,
  sent: { reason: ComplaintReasonValue; text: string | null },
): ComplaintFailure {
  if (isApiError(error)) {
    switch (error.code) {
      case "COMPLAINT_EXISTS":
        return { kind: "exists" };
      case "COMPLAINT_NOT_ALLOWED":
        return reasonOf(error) === "not_received_requires_completed"
          ? { kind: "not_received_requires_completed" }
          : { kind: "order_not_accepted" };
      case "VALIDATION_ERROR":
        if (!validationPaths(error).includes("text")) return { kind: "other" };
        return sent.reason === "other" && sent.text === null
          ? { kind: "text_required" }
          : { kind: "too_long" };
    }
  }
  return commonFailure(error);
}

/** The words of a refusal; `null` — nothing to say (the session ended: the app is a guest already). */
export const reviewFailureKeys = {
  exists: "review.failed.exists",
  test_order: "review.testOrder",
  not_completed: "review.failed.notCompleted",
  edit_used: "review.failed.editUsed",
  not_rejected: "review.failed.notRejected",
  rate_limited: "feedback.failed.tooMany",
  too_long: "feedback.failed.tooLong",
  not_found: "order.notFound",
  network: "feedback.failed.network",
  other: "feedback.failed.other",
} as const satisfies Record<Exclude<ReviewFailure["kind"], "session_ended">, string>;

export const complaintFailureKeys = {
  exists: "complaint.failed.exists",
  order_not_accepted: "complaint.failed.notAccepted",
  not_received_requires_completed: "complaint.failed.notReceived",
  rate_limited: "feedback.failed.tooMany",
  too_long: "feedback.failed.tooLong",
  text_required: "complaint.textRequired",
  not_found: "order.notFound",
  network: "feedback.failed.network",
  other: "feedback.failed.other",
} as const satisfies Record<Exclude<ComplaintFailure["kind"], "session_ended">, string>;

/**
 * After a refusal the screen either stays (the person may change something
 * and send again) or goes back to the order, which then shows what is true.
 */
export function leavesForm(failure: ReviewFailure | ComplaintFailure): boolean {
  switch (failure.kind) {
    case "exists":
    case "test_order":
    case "not_completed":
    case "edit_used":
    case "not_rejected":
    case "order_not_accepted":
    case "not_found":
      return true;
    default:
      return false;
  }
}
