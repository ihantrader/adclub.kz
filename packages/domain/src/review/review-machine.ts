/**
 * Reviews and complaints of users about an order (PRODUCT 13; D-042;
 * ARCHITECTURE 5.9, 4.69; TASK-049). One table decides which action moves a
 * review from which status to which, and one decides it for a complaint:
 * the server applies a move only by a conditional update that still finds
 * the row in the status the move starts from.
 *
 * **A review** (`review`):
 *
 * - `checking` — waits for the check (the rules and AI) before it is shown;
 * - `published` — shown on the supplier's page;
 * - `held` — the check found a reason, or waited longer than
 *   `review_check_max_wait_minutes`: an administrator decides. The check
 *   never refuses by itself (PRODUCT 13);
 * - `text_rejected` — an administrator refused the text with a reason from
 *   the list; the user sees the reason and may correct the text once or
 *   publish the score alone;
 * - `hidden` — an administrator hid a published review, with a reason.
 *
 * A score without a text has nothing to check and is published at once.
 * A published review is never edited by its author.
 *
 * **A complaint** (`complaint`): `new` → `in_progress` («Взять в работу») →
 * `resolved` («Решить» with an internal comment); a new one may be resolved
 * straight away. One open complaint per order; after «решена» — a new one.
 */

export const reviewStatuses = ["checking", "published", "held", "text_rejected", "hidden"] as const;

export type ReviewStatus = (typeof reviewStatuses)[number];

/**
 * - `pass_check`, `hold` — the check: nothing found / a reason found or the
 *   wait ran out (the server);
 * - `publish`, `reject_text`, `hide`, `restore` — the administrator;
 * - `edit_text`, `publish_score_only` — the author after `text_rejected`.
 */
export const reviewActions = [
  "pass_check",
  "hold",
  "publish",
  "reject_text",
  "hide",
  "restore",
  "edit_text",
  "publish_score_only",
] as const;

export type ReviewAction = (typeof reviewActions)[number];

const REVIEW_MOVES: Readonly<Record<ReviewAction, { from: ReviewStatus; to: ReviewStatus }>> = {
  pass_check: { from: "checking", to: "published" },
  hold: { from: "checking", to: "held" },
  publish: { from: "held", to: "published" },
  reject_text: { from: "held", to: "text_rejected" },
  hide: { from: "published", to: "hidden" },
  restore: { from: "hidden", to: "published" },
  edit_text: { from: "text_rejected", to: "checking" },
  publish_score_only: { from: "text_rejected", to: "published" },
};

/** What a move needs to know besides the status. */
export interface ReviewFacts {
  /** The author has corrected the text once already (it may be done only once). */
  edited: boolean;
}

/** The status an action moves a review to from this one; `null` — the action is not possible. */
export function reviewTransition(
  status: ReviewStatus,
  action: ReviewAction,
  facts: ReviewFacts = { edited: false },
): ReviewStatus | null {
  const move = REVIEW_MOVES[action];
  if (move.from !== status) {
    return null;
  }
  if (action === "edit_text" && facts.edited) {
    return null;
  }
  return move.to;
}

/** The status the moves of an action start from (for the conditional update). */
export function reviewActionFrom(action: ReviewAction): ReviewStatus {
  return REVIEW_MOVES[action].from;
}

/** A new review: with a text it waits for the check, a score alone is published at once. */
export function initialReviewStatus(text: string | null): ReviewStatus {
  return text === null ? "published" : "checking";
}

/**
 * The text of a review as it is kept: spaces at the ends cut, empty and
 * blank — no text at all (a score alone).
 */
export function reviewText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}

/**
 * What the author sees of their review (SCREENS M-ORD-03, M-ORD-05):
 * «Отзыв на проверке» while the check or the administrator decides — the
 * reason of a hold is not theirs to see until a decision; «Отзыв
 * опубликован» once published, **and after it was hidden** (the author is
 * not told about a hide nor its reason — ARCHITECTURE 4.69); T-REV-02 with
 * the reason once the text was refused.
 */
export type ReviewUserStatus = "checking" | "published" | "text_rejected";

export function reviewUserStatus(status: ReviewStatus): ReviewUserStatus {
  switch (status) {
    case "checking":
    case "held":
      return "checking";
    case "published":
    case "hidden":
      return "published";
    case "text_rejected":
      return "text_rejected";
  }
}

/** «Исправить текст» (once) and «Опубликовать только оценку» under T-REV-02. */
export function reviewAuthorActions(
  status: ReviewStatus,
  facts: ReviewFacts,
): { canEditText: boolean; canPublishScoreOnly: boolean } {
  return {
    canEditText: reviewTransition(status, "edit_text", facts) !== null,
    canPublishScoreOnly: reviewTransition(status, "publish_score_only", facts) !== null,
  };
}

/**
 * Why a review is held (A-REV-01): the reasons the check gives. Three come
 * from the deterministic rules — `contacts` (a phone, a link, an e-mail —
 * `warrantyTextContacts`), `supplier_name` (the name of the order's
 * supplier), `employee_name` (a name of its employees); four from AI —
 * `profanity` (мат и оскорбления), `threat`, `personal_data`, `advertising`;
 * and `check_unavailable` — the check could not be made in time.
 */
export const reviewHoldKinds = [
  "contacts",
  "supplier_name",
  "employee_name",
  "profanity",
  "threat",
  "personal_data",
  "advertising",
  "check_unavailable",
] as const;

export type ReviewHoldKind = (typeof reviewHoldKinds)[number];

/** The violations AI is asked about — the fixed list of its answer. */
export const reviewAiViolationKinds = [
  "profanity",
  "threat",
  "personal_data",
  "advertising",
] as const satisfies readonly ReviewHoldKind[];

export type ReviewAiViolationKind = (typeof reviewAiViolationKinds)[number];

/**
 * The reasons an administrator refuses a text with — the user sees them
 * (SCREENS M-ORD-05, T-REV-02): «мат или оскорбления», «личные данные»,
 * «название поставщика», «реклама или ссылки». Working texts until a
 * lawyer approves the rules of publication (STATE).
 */
export const reviewRejectReasons = [
  "profanity",
  "personal_data",
  "supplier_name",
  "advertising",
] as const;

export type ReviewRejectReason = (typeof reviewRejectReasons)[number];

// --------------------------------------------------------------- complaints

export const complaintStatuses = ["new", "in_progress", "resolved"] as const;

export type ComplaintStatus = (typeof complaintStatuses)[number];

export type ComplaintAction = "take" | "resolve";

/** «Взять в работу» — a new one; «Решить» — a new one or one in work. */
export function complaintTransition(
  status: ComplaintStatus,
  action: ComplaintAction,
): ComplaintStatus | null {
  if (action === "take") {
    return status === "new" ? "in_progress" : null;
  }
  return status === "resolved" ? null : "resolved";
}

/** «Жалоба на рассмотрении» while it is new or in work, «Жалоба рассмотрена» once resolved. */
export function complaintUserStatus(status: ComplaintStatus): "in_review" | "resolved" {
  return status === "resolved" ? "resolved" : "in_review";
}

/**
 * The reasons of M-ORD-06: «Не получил товар или услугу», «Товар не
 * соответствует», «Цена выше клубной», «Поставщик не выходил на связь»,
 * «Другое» (the text is required for «Другое» only).
 */
export const complaintReasons = [
  "not_received",
  "not_as_described",
  "price_higher",
  "no_contact",
  "other",
] as const;

export type ComplaintReason = (typeof complaintReasons)[number];

/** The final statuses and the accepted ones a complaint may be made about. */
const COMPLAINABLE = new Set<string>([
  "accepted",
  "ready",
  "completed",
  "cancelled_by_user",
  "declined_by_supplier",
  "response_expired",
  "reserve_expired",
  "cancelled_by_admin",
  "term_expired",
  "no_show",
  "visit_unresolved",
]);

/**
 * The reasons a user may complain with about an order in this status (TASK-049
 * requirement 2): an order the supplier accepted or one that is over; not one
 * still waiting for an answer. «Не получил товар» belongs to an order given
 * out (T-ORD-08, P-ORD-06) — `completed` only. Empty — no complaint now.
 * A test order may be complained about too: a complaint is not statistics.
 */
export function complaintReasonsFor(orderStatus: string): ComplaintReason[] {
  if (!COMPLAINABLE.has(orderStatus)) {
    return [];
  }
  return orderStatus === "completed"
    ? [...complaintReasons]
    : complaintReasons.filter((reason) => reason !== "not_received");
}

// ------------------------------------------------------------------ author

/**
 * The author of a published review on the supplier's page (M-CAT-09:
 * «Айгерим К.»): the first name and the initial of the second word of the
 * account's name, read when the page is read (a later change of the name or
 * the account's removal is seen at once). One word — the word alone; no
 * name — `null` (the app says «Участник клуба»). Never the phone or the id.
 */
export function reviewAuthorName(name: string | null | undefined): string | null {
  const words = (name ?? "")
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const first = words[0];
  if (!first) {
    return null;
  }
  const second = words[1];
  if (!second) {
    return first;
  }
  const initial = [...second][0]!.toLocaleUpperCase("ru");
  return `${first} ${initial}.`;
}
