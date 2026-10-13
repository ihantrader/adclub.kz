import { z } from "zod";
import { hiddenPhoneSchema } from "./account";

/**
 * Reviews and complaints (PRODUCT 13; D-042; ARCHITECTURE 5.9, 4.69;
 * SCREENS M-ORD-05, M-ORD-06, A-REV-01, A-REV-02, M-CAT-09; TASK-049).
 *
 * A user reviews an order that was given out (a visit for a service that was
 * done): a score of 1–5 and a text if they like. A text is checked before it
 * is shown — deterministic rules (contacts, the supplier's name, names of its
 * employees) and AI (profanity and insults, threats, personal data,
 * advertising). The check never refuses: a finding holds the review for an
 * administrator, who publishes it or refuses the text with a reason the user
 * sees. A refused text may be corrected once, or the score published alone.
 *
 * A complaint is about an order the supplier accepted or one that is over;
 * the supplier never sees complaints anywhere.
 */

/** The longest text the contract takes; the setting `review_text_max_length` may ask for less. */
export const REVIEW_TEXT_LIMIT = 2000;
/** The longest complaint text; the setting `complaint_text_max_length` may ask for less. */
export const COMPLAINT_TEXT_LIMIT = 2000;
/** Why an administrator hid a review or resolved a complaint (their own words). */
export const REVIEW_ADMIN_REASON_MAX_LENGTH = 500;
export const REVIEW_PAGE_MAX_SIZE = 100;
export const REVIEW_PAGE_DEFAULT_SIZE = 30;

/** A text of one or several lines, without other control characters; blank — none. */
function optionalMultiline(max: number) {
  return z
    .string()
    .max(max)
    .regex(/^(?:[^\p{Cc}]|\n|\r|\t)*$/u, { message: "Must not contain control characters" });
}

function requiredText(max: number) {
  return z
    .string()
    .trim()
    .min(3, { message: "At least 3 characters" })
    .max(max)
    .regex(/^(?:[^\p{Cc}]|\n)*$/u, { message: "Must not contain control characters" });
}

// ------------------------------------------------------------------ reviews

/**
 * `checking` — waits for the check; `published`; `held` — the check found a
 * reason or could not be made in time, an administrator decides;
 * `text_rejected` — an administrator refused the text; `hidden` — an
 * administrator hid a published review.
 */
export const reviewStatusSchema = z.enum([
  "checking",
  "published",
  "held",
  "text_rejected",
  "hidden",
]);

export type ReviewStatusValue = z.infer<typeof reviewStatusSchema>;

/**
 * Why a review is held (A-REV-01): `contacts`, `supplier_name`,
 * `employee_name` — the rules; `profanity` (мат и оскорбления), `threat`,
 * `personal_data`, `advertising` — AI; `check_unavailable` — the check could
 * not be made in time (`review_check_max_wait_minutes`).
 */
export const reviewHoldKindSchema = z.enum([
  "contacts",
  "supplier_name",
  "employee_name",
  "profanity",
  "threat",
  "personal_data",
  "advertising",
  "check_unavailable",
]);

export type ReviewHoldKind = z.infer<typeof reviewHoldKindSchema>;

/**
 * The reasons an administrator refuses a text with; the user sees them
 * (T-REV-02): «мат или оскорбления», «личные данные», «название
 * поставщика», «реклама или ссылки».
 */
export const reviewRejectReasonSchema = z.enum([
  "profanity",
  "personal_data",
  "supplier_name",
  "advertising",
]);

export type ReviewRejectReason = z.infer<typeof reviewRejectReasonSchema>;

/**
 * One reason of a hold: what was found, by what (`rule` — the deterministic
 * rules, `ai` — the model, [AI] on the screen; `system` — the check could not
 * be made) and a short explanation (the model's words, or which contacts).
 */
export const reviewHoldReasonSchema = z.object({
  kind: reviewHoldKindSchema,
  source: z.enum(["rule", "ai", "system"]),
  explanation: z.string().nullable(),
});

export type ReviewHoldReason = z.infer<typeof reviewHoldReasonSchema>;

/**
 * The author's own review on their order (M-ORD-03, M-ORD-05):
 *
 * - `status` — `checking` («Отзыв на проверке»: the check or the
 *   administrator decides; the reason of a hold is not shown), `published`
 *   («Отзыв опубликован»; a review the administrator hid is shown so too),
 *   `text_rejected` (T-REV-02 with `rejection.reason`);
 * - `canEditText` — «Исправить текст» (once); `canPublishScoreOnly` —
 *   «Опубликовать только оценку».
 */
export const userOrderReviewSchema = z.object({
  id: z.uuid(),
  score: z.number().int().min(1).max(5),
  text: z.string().nullable(),
  status: z.enum(["checking", "published", "text_rejected"]),
  rejection: z.object({ reason: reviewRejectReasonSchema }).nullable(),
  canEditText: z.boolean(),
  canPublishScoreOnly: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type UserOrderReview = z.infer<typeof userOrderReviewSchema>;

/**
 * `POST /reviews` (M-ORD-05). `text` — blank is no text (a score alone is
 * published at once). `idempotencyKey` — made by the app when the screen
 * opens: the same review sent again returns the one already created.
 */
export const createReviewBodySchema = z.object({
  orderId: z.uuid(),
  score: z.number().int().min(1).max(5),
  text: optionalMultiline(REVIEW_TEXT_LIMIT).nullish(),
  idempotencyKey: z.uuid(),
});

export type CreateReviewBody = z.infer<typeof createReviewBodySchema>;

export const reviewResponseSchema = z.object({
  review: userOrderReviewSchema,
  /** `false` — the same request came again and the review created then is returned. */
  created: z.boolean(),
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const reviewPathSchema = z.object({ reviewId: z.uuid() });

export type ReviewPath = z.infer<typeof reviewPathSchema>;

/** «Исправить текст» after T-REV-02 — once; the new text is checked again. */
export const editReviewTextBodySchema = z.object({
  text: requiredText(REVIEW_TEXT_LIMIT),
});

export type EditReviewTextBody = z.infer<typeof editReviewTextBodySchema>;

export const userReviewResponseSchema = z.object({ review: userOrderReviewSchema });

export type UserReviewResponse = z.infer<typeof userReviewResponseSchema>;

/**
 * `details` of 409 `REVIEW_NOT_ALLOWED`: `not_completed` — the order was not
 * given out (a visit not done); `test_order` — «Отзыв недоступен: это
 * тестовый заказ».
 */
export const reviewNotAllowedDetailsSchema = z.object({
  reason: z.enum(["not_completed", "test_order"]),
});

export type ReviewNotAllowedDetails = z.infer<typeof reviewNotAllowedDetailsSchema>;

/** `details` of 409 `REVIEW_EXISTS`: the order has a review already. */
export const reviewExistsDetailsSchema = z.object({ reviewId: z.uuid() });

/**
 * `details` of 409 `REVIEW_STATE` (the author's action): `edit_used` — the
 * text was corrected once already; `not_rejected` — the text is not refused
 * (nothing to correct or to drop).
 */
export const reviewStateDetailsSchema = z.object({
  reason: z.enum(["edit_used", "not_rejected"]),
});

// ------------------------------------------------- the supplier's page (public)

/**
 * `GET /suppliers/{supplierId}/reviews` (M-CAT-09; TASK-050 adds the
 * rating). The published reviews of one supplier, newest first — by the rule
 * of the showcase (`showcase-visibility`): to a guest and to a user without
 * club access the supplier is hidden, so `supplier` is `hidden` and there are
 * no reviews, the same answer for any id.
 */
export const supplierReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(REVIEW_PAGE_MAX_SIZE).default(REVIEW_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type SupplierReviewsQuery = z.infer<typeof supplierReviewsQuerySchema>;

export const supplierPathSchema = z.object({ supplierId: z.uuid() });

export type SupplierPath = z.infer<typeof supplierPathSchema>;

/**
 * One published review: the score, the text, the month it was published in
 * (`YYYY-MM`, the club's time zone) and the author as «Айгерим К.» (`null` —
 * the account has no name: «Участник клуба»). Never the phone or the id of
 * the user, nor the order.
 */
export const publicReviewSchema = z.object({
  id: z.uuid(),
  score: z.number().int().min(1).max(5),
  text: z.string().nullable(),
  publishedMonth: z.string().regex(/^\d{4}-\d{2}$/),
  author: z.string().nullable(),
});

export type PublicReview = z.infer<typeof publicReviewSchema>;

export const supplierReviewsResponseSchema = z.object({
  viewer: z.object({ signedIn: z.boolean(), clubAccess: z.boolean() }),
  supplier: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("hidden"),
      reason: z.enum(["auth_required", "subscription_required"]),
    }),
    z.object({ kind: z.literal("visible"), id: z.uuid(), name: z.string() }),
  ]),
  reviews: z.array(publicReviewSchema),
  /** Published reviews of the supplier (0 while hidden). */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type SupplierReviewsResponse = z.infer<typeof supplierReviewsResponseSchema>;

// -------------------------------------------------------- reviews (admin)

/** Who of the administrators decided, and when. */
export const reviewAdminActorSchema = z.object({
  adminId: z.uuid(),
  name: z.string().nullable(),
});

export type ReviewAdminActor = z.infer<typeof reviewAdminActorSchema>;

/**
 * A review for the administrator (A-REV-01, A-SUP-03 «Отзывы», A-ORD-02):
 * the score, the text, the reasons of a hold with their source, the order
 * and the supplier, the author (the number partly hidden), the decisions.
 */
export const adminReviewSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: reviewStatusSchema,
  score: z.number().int().min(1).max(5),
  text: z.string().nullable(),
  holdReasons: z.array(reviewHoldReasonSchema),
  /** The text refused: why (the user sees it). */
  rejection: z
    .object({ reason: reviewRejectReasonSchema, at: z.iso.datetime(), by: reviewAdminActorSchema })
    .nullable(),
  /** The review hidden: why (only the administrators see it). */
  hidden: z
    .object({ reason: z.string(), at: z.iso.datetime(), by: reviewAdminActorSchema })
    .nullable(),
  /** The author corrected the text after a refusal (it may be done once). */
  edited: z.boolean(),
  /** Since when the text has waited for its check; `null` — not waiting. */
  checkingSince: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  order: z.object({ id: z.uuid(), number: z.number().int(), kind: z.string() }),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  author: z.object({
    accountId: z.uuid(),
    name: z.string().nullable(),
    phone: hiddenPhoneSchema,
  }),
});

export type AdminReview = z.infer<typeof adminReviewSchema>;

/**
 * A-REV-01: by status (`held` — «На проверке»; a text waiting longer than
 * `review_check_max_wait_minutes` is `held` already), supplier, author,
 * order, a part of the text. «На проверке» goes oldest first (a queue), the
 * others newest first.
 */
export const adminReviewListQuerySchema = z.object({
  status: reviewStatusSchema.optional(),
  supplierId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(REVIEW_PAGE_MAX_SIZE).default(REVIEW_PAGE_DEFAULT_SIZE),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type AdminReviewListQuery = z.infer<typeof adminReviewListQuerySchema>;

export const adminReviewPageSchema = z.object({
  reviews: z.array(adminReviewSchema),
  total: z.number().int(),
  /** Reviews by status with the same other filters (the tabs of A-REV-01). */
  counts: z.record(reviewStatusSchema, z.number().int()),
  nextOffset: z.number().int().nullable(),
});

export type AdminReviewPage = z.infer<typeof adminReviewPageSchema>;

export const adminReviewResponseSchema = z.object({ review: adminReviewSchema });

export type AdminReviewResponse = z.infer<typeof adminReviewResponseSchema>;

/** «Опубликовать» (held) and «Вернуть» (hidden): the version the administrator saw. */
export const adminReviewActionBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export type AdminReviewActionBody = z.infer<typeof adminReviewActionBodySchema>;

/** «Отклонить текст» with a reason from the list — the user sees it. */
export const rejectReviewTextBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: reviewRejectReasonSchema,
});

export type RejectReviewTextBody = z.infer<typeof rejectReviewTextBodySchema>;

/** «Скрыть» a published review, with a reason (the administrators only see it). */
export const hideReviewBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: requiredText(REVIEW_ADMIN_REASON_MAX_LENGTH),
});

export type HideReviewBody = z.infer<typeof hideReviewBodySchema>;

/** `details` of 409 `REVIEW_CONFLICT`: the review as it is now (who decided first, and when). */
export const reviewConflictDetailsSchema = z.object({ review: adminReviewSchema });

export type ReviewConflictDetails = z.infer<typeof reviewConflictDetailsSchema>;

// --------------------------------------------------------------- complaints

/**
 * M-ORD-06: «Не получил товар или услугу», «Товар не соответствует», «Цена
 * выше клубной», «Поставщик не выходил на связь», «Другое».
 */
export const complaintReasonSchema = z.enum([
  "not_received",
  "not_as_described",
  "price_higher",
  "no_contact",
  "other",
]);

export type ComplaintReasonValue = z.infer<typeof complaintReasonSchema>;

/** `new` → `in_progress` («Взять в работу») → `resolved` («Решить»). */
export const complaintStatusSchema = z.enum(["new", "in_progress", "resolved"]);

export type ComplaintStatusValue = z.infer<typeof complaintStatusSchema>;

/**
 * The user's latest complaint about their order (M-ORD-03): «Жалоба на
 * рассмотрении» (`in_review`) / «Жалоба рассмотрена» (`resolved`). The
 * administrator's comment is never here — the answer on the merits is given
 * outside the app.
 */
export const userOrderComplaintSchema = z.object({
  id: z.uuid(),
  reason: complaintReasonSchema,
  status: z.enum(["in_review", "resolved"]),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export type UserOrderComplaint = z.infer<typeof userOrderComplaintSchema>;

/**
 * `POST /complaints` (M-ORD-06): `text` is required for «Другое» and optional
 * otherwise; `idempotencyKey` as for an order.
 */
export const createComplaintBodySchema = z
  .object({
    orderId: z.uuid(),
    reason: complaintReasonSchema,
    text: optionalMultiline(COMPLAINT_TEXT_LIMIT).nullish(),
    idempotencyKey: z.uuid(),
  })
  .superRefine((body, context) => {
    if (body.reason === "other" && (body.text ?? "").trim() === "") {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Describe the problem: the text is required for «Другое»",
      });
    }
  });

export type CreateComplaintBody = z.infer<typeof createComplaintBodySchema>;

export const complaintResponseSchema = z.object({
  complaint: userOrderComplaintSchema,
  created: z.boolean(),
});

export type ComplaintResponse = z.infer<typeof complaintResponseSchema>;

/**
 * `details` of 409 `COMPLAINT_NOT_ALLOWED`: `order_not_accepted` — the order
 * still waits for an answer (a complaint is about an accepted order or one
 * that is over); `not_received_requires_completed` — «Не получил товар» is
 * about an order given out.
 */
export const complaintNotAllowedDetailsSchema = z.object({
  reason: z.enum(["order_not_accepted", "not_received_requires_completed"]),
});

/** `details` of 409 `COMPLAINT_EXISTS`: the order has an open complaint. */
export const complaintExistsDetailsSchema = z.object({ complaintId: z.uuid() });

/** A complaint for the administrator (A-REV-02): with the internal comment. */
export const adminComplaintSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: complaintStatusSchema,
  reason: complaintReasonSchema,
  text: z.string().nullable(),
  /** The administrator's internal comment at «Решить»; the user never sees it. */
  comment: z.string().nullable(),
  order: z.object({
    id: z.uuid(),
    number: z.number().int(),
    status: z.string(),
    isTest: z.boolean(),
  }),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  user: z.object({ accountId: z.uuid(), name: z.string().nullable(), phone: hiddenPhoneSchema }),
  takenBy: reviewAdminActorSchema.nullable(),
  takenAt: z.iso.datetime().nullable(),
  resolvedBy: reviewAdminActorSchema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminComplaint = z.infer<typeof adminComplaintSchema>;

/** `open` — new and in work. */
export const adminComplaintListQuerySchema = z.object({
  status: z.enum(["new", "in_progress", "resolved", "open"]).optional(),
  reason: complaintReasonSchema.optional(),
  supplierId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(REVIEW_PAGE_MAX_SIZE).default(REVIEW_PAGE_DEFAULT_SIZE),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type AdminComplaintListQuery = z.infer<typeof adminComplaintListQuerySchema>;

export const adminComplaintPageSchema = z.object({
  complaints: z.array(adminComplaintSchema),
  total: z.number().int(),
  /** Complaints by status with the same other filters. */
  counts: z.record(complaintStatusSchema, z.number().int()),
  nextOffset: z.number().int().nullable(),
});

export type AdminComplaintPage = z.infer<typeof adminComplaintPageSchema>;

export const complaintPathSchema = z.object({ complaintId: z.uuid() });

export type ComplaintPath = z.infer<typeof complaintPathSchema>;

export const adminComplaintResponseSchema = z.object({ complaint: adminComplaintSchema });

export type AdminComplaintResponse = z.infer<typeof adminComplaintResponseSchema>;

/** «Взять в работу»: the version the administrator saw. */
export const takeComplaintBodySchema = z.object({ expectedVersion: z.number().int().min(1) });

export type TakeComplaintBody = z.infer<typeof takeComplaintBodySchema>;

/** «Решить» with the internal comment (required). */
export const resolveComplaintBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  comment: requiredText(REVIEW_ADMIN_REASON_MAX_LENGTH * 2),
});

export type ResolveComplaintBody = z.infer<typeof resolveComplaintBodySchema>;

/** `details` of 409 `COMPLAINT_CONFLICT`: the complaint as it is now. */
export const complaintConflictDetailsSchema = z.object({ complaint: adminComplaintSchema });

export type ComplaintConflictDetails = z.infer<typeof complaintConflictDetailsSchema>;
