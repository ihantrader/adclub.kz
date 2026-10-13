import { isApiError } from "@adclub/api-client";
import {
  complaintConflictDetailsSchema,
  reviewConflictDetailsSchema,
  type AdminComplaint,
  type AdminReview,
  type ComplaintReasonValue,
  type ComplaintStatusValue,
  type ReviewHoldKind,
  type ReviewHoldReason,
  type ReviewRejectReason,
  type ReviewStatusValue,
} from "@adclub/contracts";
import { actionErrorText } from "../errors";
import { formatMoment } from "../format";

/**
 * The words of A-REV-01 and A-REV-02 (TASK-049): what a review or a complaint
 * is and what happened to it. The server decides everything — the reasons of
 * a hold, which decision is possible, who acted first; these only say it.
 */

export const REVIEW_STATUS_TEXT: Record<ReviewStatusValue, string> = {
  checking: "Проверяется",
  held: "На проверке",
  published: "Опубликован",
  hidden: "Скрыт",
  text_rejected: "Текст отклонён",
};

/** The tabs of «Отзывы» in their order: the queue first. */
export const REVIEW_TABS: readonly { status: ReviewStatusValue; label: string }[] = [
  { status: "held", label: "На проверке" },
  { status: "published", label: "Опубликованные" },
  { status: "hidden", label: "Скрытые" },
  { status: "text_rejected", label: "Отклонённые" },
  { status: "checking", label: "Проверяются" },
];

export const HOLD_KIND_TEXT: Record<ReviewHoldKind, string> = {
  contacts: "контакты",
  supplier_name: "название поставщика",
  employee_name: "имя сотрудника",
  profanity: "мат или оскорбления",
  threat: "угрозы",
  personal_data: "личные данные",
  advertising: "реклама или ссылки",
  check_unavailable: "проверка недоступна",
};

/** The reasons of «Отклонить текст» — the user sees them (T-REV-02). */
export const REJECT_REASON_TEXT: Record<ReviewRejectReason, string> = {
  profanity: "мат или оскорбления",
  personal_data: "личные данные",
  supplier_name: "название поставщика",
  advertising: "реклама или ссылки",
};

/**
 * One reason of a hold for the queue: its words, the explanation and [AI] at
 * what the model found (A-REV-01).
 */
export function holdReasonText(reason: ReviewHoldReason): string {
  const words = HOLD_KIND_TEXT[reason.kind];
  const explanation = reason.explanation ? ` (${reason.explanation})` : "";
  return reason.source === "ai" ? `[AI] ${words}${explanation}` : `${words}${explanation}`;
}

/** The reason from the list the queue suggests for «Отклонить текст»: the first one found. */
export function suggestedRejectReason(
  review: Pick<AdminReview, "holdReasons">,
): ReviewRejectReason {
  for (const reason of review.holdReasons) {
    switch (reason.kind) {
      case "profanity":
      case "threat":
        return "profanity";
      case "contacts":
      case "personal_data":
      case "employee_name":
        return "personal_data";
      case "supplier_name":
        return "supplier_name";
      case "advertising":
        return "advertising";
      default:
        break;
    }
  }
  return "personal_data";
}

/** The mark of a status: the queue — attention, published — done, refused — danger. */
export function reviewTone(status: ReviewStatusValue): string {
  switch (status) {
    case "held":
      return "status--open";
    case "checking":
      return "status--acknowledged";
    case "published":
      return "status--done";
    case "hidden":
      return "status--closed";
    case "text_rejected":
      return "status--danger";
  }
}

export function complaintTone(status: ComplaintStatusValue): string {
  return status === "new"
    ? "status--open"
    : status === "in_progress"
      ? "status--acknowledged"
      : "status--done";
}

/** «★★★★☆ 4». */
export function scoreText(score: number): string {
  return `${"★".repeat(score)}${"☆".repeat(Math.max(0, 5 - score))} ${score}`;
}

/** The administrator's decisions a review allows now, by the one table of the server. */
export function reviewActions(status: ReviewStatusValue): {
  publish: boolean;
  rejectText: boolean;
  hide: boolean;
  restore: boolean;
} {
  return {
    publish: status === "held",
    rejectText: status === "held",
    hide: status === "published",
    restore: status === "hidden",
  };
}

function who(name: string | null | undefined): string {
  return name ?? "другой администратор";
}

/** Why a decision was refused: who decided first and what the review is now. */
export function reviewConflictText(review: AdminReview): string {
  switch (review.status) {
    case "published":
      return "Отзыв уже опубликован. Обновите страницу";
    case "text_rejected":
      return review.rejection
        ? `Текст уже отклонил ${who(review.rejection.by.name)} ${formatMoment(review.rejection.at)}`
        : "Текст уже отклонён. Обновите страницу";
    case "hidden":
      return review.hidden
        ? `Отзыв уже скрыл ${who(review.hidden.by.name)} ${formatMoment(review.hidden.at)}`
        : "Отзыв уже скрыт. Обновите страницу";
    case "checking":
      return "Автор исправил текст — он снова проверяется. Обновите страницу";
    default:
      return "Эти данные только что изменили. Обновите страницу";
  }
}

/** The review as it is now, from a `REVIEW_CONFLICT`; `null` — another refusal. */
export function conflictReview(error: unknown): AdminReview | null {
  if (!isApiError(error) || error.code !== "REVIEW_CONFLICT") return null;
  const details = reviewConflictDetailsSchema.safeParse(error.details);
  return details.success ? details.data.review : null;
}

/** A refused decision on a review in words; a conflict names who was first. */
export function reviewErrorText(error: unknown): string {
  if (isApiError(error) && error.code === "REVIEW_CONFLICT") {
    const details = reviewConflictDetailsSchema.safeParse(error.details);
    return details.success
      ? reviewConflictText(details.data.review)
      : "Эти данные только что изменили. Обновите страницу";
  }
  return actionErrorText(error);
}

// --------------------------------------------------------------- complaints

export const COMPLAINT_REASON_TEXT: Record<ComplaintReasonValue, string> = {
  not_received: "Не получил товар или услугу",
  not_as_described: "Товар не соответствует",
  price_higher: "Цена выше клубной",
  no_contact: "Поставщик не выходил на связь",
  other: "Другое",
};

export const COMPLAINT_STATUS_TEXT: Record<ComplaintStatusValue, string> = {
  new: "Новая",
  in_progress: "В работе",
  resolved: "Решена",
};

export const COMPLAINT_STATUS_FILTERS: readonly {
  value: "open" | ComplaintStatusValue | "all";
  label: string;
}[] = [
  { value: "open", label: "Новые и в работе" },
  { value: "new", label: "Новые" },
  { value: "in_progress", label: "В работе" },
  { value: "resolved", label: "Решённые" },
  { value: "all", label: "Все" },
];

/** Why «Взять в работу» or «Решить» was refused: who acted first. */
export function complaintConflictText(complaint: AdminComplaint): string {
  if (complaint.status === "resolved") {
    return `Жалобу уже решил ${who(complaint.resolvedBy?.name)} ${formatMoment(complaint.resolvedAt)}`;
  }
  if (complaint.status === "in_progress") {
    return `Жалобу уже взял в работу ${who(complaint.takenBy?.name)} ${formatMoment(complaint.takenAt)}`;
  }
  return "Эти данные только что изменили. Обновите страницу";
}

export function complaintErrorText(error: unknown): string {
  if (isApiError(error) && error.code === "COMPLAINT_CONFLICT") {
    const details = complaintConflictDetailsSchema.safeParse(error.details);
    return details.success
      ? complaintConflictText(details.data.complaint)
      : "Эти данные только что изменили. Обновите страницу";
  }
  return actionErrorText(error);
}
