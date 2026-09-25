import { z } from "zod";
import { catalogLanguageSchema, localizedTextSchema } from "./catalog";
import { OFFER_PRICE_LIMIT, offerAvailabilitySchema } from "./offers";
import { dayHoursSchema } from "./suppliers";

/**
 * Orders on items in stock (PRODUCT 10.1, 10.2, 10.4, 12.6; SCREENS
 * M-ORD-01…03, S-ORD-01…03, A-ORD-01, A-ORD-02; ARCHITECTURE 5.7, 6.1,
 * 4.31; TASK-021). A user with club access orders from one offer of one
 * supplier (a quantity, the total is the sum); the order keeps a snapshot
 * of the offer's terms; the supplier accepts or declines it; the order
 * lives by its deadlines. Every action of the supplier is recorded against
 * an employee — seen by the supplier and the administrator, never by the
 * user. The confirmation code and the QR go to the user only: no answer
 * to the supplier or the administrator has them. The user's phone number
 * reaches the supplier only once that order is accepted.
 *
 * TASK-022 (PRODUCT 10.1, 10.5, 10.7; SCREENS S-SCAN-01…04, A-ORD-01,
 * A-ORD-02, A-USR-01…03; ARCHITECTURE 6.5, 4.32; D-043) adds the end of
 * the order: an employee of the company finds it by the code the customer
 * says or by the content of the QR and gives it out — the only way to
 * «Выдана» besides the administrator's close with a reason. An order whose
 * pickup reserve expired is still given out inside the late close window;
 * the no-show of the customer is kept as the club's own discipline mark
 * and lifted when the order is closed late after all. Orders under order
 * and for services — EPIC-13.
 */

/** Upper bounds of the contract; the working bound of the quantity is the setting `order_max_quantity`. */
export const ORDER_QUANTITY_LIMIT = 999;
export const ORDER_COMMENT_MAX_LENGTH = 500;
export const ORDER_DECLINE_NOTE_MAX_LENGTH = 300;
/** Why the administrator closed an order without a code, or lifted a discipline mark. */
export const ORDER_REASON_MAX_LENGTH = 300;
export const ORDER_PAGE_MAX_SIZE = 100;
export const ORDER_PAGE_DEFAULT_SIZE = 30;
/** The confirmation code: this many digits (spoken and typed on a keypad at a counter). */
export const ORDER_CODE_LENGTH = 6;
/** The QR of an order is this prefix and a random token (the scanner of TASK-022 recognizes it). */
export const ORDER_QR_PREFIX = "ADCLUB-ORDER:";

/** A text of one or several lines, without other control characters. */
function freeText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

function multilineText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^(?:[^\p{Cc}]|\n)*$/u, { message: "Must not contain control characters" });
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Must be YYYY-MM-DD" });
const expectedVersionSchema = z.number().int().min(1);

/**
 * `created` — waits for the supplier's answer (until `respondBy`);
 * `accepted` — the supplier accepted it (the user's phone is open to it);
 * `ready` — ready to be given out (optional, D-040); `completed` — given
 * out by the code or the QR, or closed by the administrator with a reason;
 * `cancelled_by_user`;
 * `declined_by_supplier`; `response_expired` — the supplier didn't answer
 * in time; `reserve_expired` — the user didn't come for it in time
 * (pickup). The last five are final.
 */
export const orderStatusSchema = z.enum([
  "created",
  "accepted",
  "ready",
  "completed",
  "cancelled_by_user",
  "declined_by_supplier",
  "response_expired",
  "reserve_expired",
]);

export type OrderStatusValue = z.infer<typeof orderStatusSchema>;

/** `stock` — an item in stock (the only kind until EPIC-13: under order and services). */
export const orderKindSchema = z.enum(["stock"]);

export type OrderKind = z.infer<typeof orderKindSchema>;

export const orderFulfillmentSchema = z.enum(["pickup", "delivery"]);

export type OrderFulfillment = z.infer<typeof orderFulfillmentSchema>;

/**
 * Why the supplier declines (S-ORD-03, optional): «Нет в наличии», «Не
 * можем в этот срок», «Другое». The user never sees it.
 */
export const orderDeclineReasonSchema = z.enum(["out_of_stock", "cannot_meet_term", "other"]);

export type OrderDeclineReason = z.infer<typeof orderDeclineReasonSchema>;

/**
 * Entries of the order's journal: the moves of the state machine
 * (`create`, `accept`, `decline`, `mark_ready`, `close`, `close_late` —
 * given out inside the late close window (PRODUCT 10.7), `admin_close` —
 * closed by the administrator without a code (D-043), `cancel`,
 * `expire_no_response` — «нет ответа», `expire_reserve`) and two notes
 * that move nothing: `reserve_expiring` — the reserve ends in
 * `reserve_warning_hours` (the notification — EPIC-09), and
 * `late_action_ignored` — an employee acted on an order someone had
 * already dealt with; nothing changed.
 */
export const orderEventActionSchema = z.enum([
  "create",
  "accept",
  "decline",
  "mark_ready",
  "close",
  "close_late",
  "admin_close",
  "cancel",
  "expire_no_response",
  "expire_reserve",
  "reserve_expiring",
  "late_action_ignored",
]);

export type OrderEventAction = z.infer<typeof orderEventActionSchema>;

/** The actions a person can try on an order (named in `late_action_ignored`). */
export const orderAttemptedActionSchema = z.enum([
  "accept",
  "decline",
  "mark_ready",
  "close",
  "close_late",
  "admin_close",
  "cancel",
]);

export type OrderAttemptedAction = z.infer<typeof orderAttemptedActionSchema>;

/**
 * How an order was given out: `qr` — an employee scanned the customer's QR,
 * `code` — typed the six digits the customer said, `admin` — the
 * administrator closed a disputed order without a code, with a reason
 * (D-043). There is no fourth way to «Выдана».
 */
export const orderCloseMethodSchema = z.enum(["qr", "code", "admin"]);

export type OrderCloseMethod = z.infer<typeof orderCloseMethodSchema>;

// ------------------------------------------------------------------- parts

/** The item as the order's snapshot keeps it, in the language of the request. */
export const orderItemSchema = z.object({
  id: z.uuid(),
  type: z.enum(["part", "generic"]),
  name: localizedTextSchema,
  article: z.string().nullable(),
  brand: z.string().nullable(),
});

export type OrderItem = z.infer<typeof orderItemSchema>;

/** The terms of the offer when the order was created (the snapshot): later changes of the offer never reach them. */
export const orderTermsSchema = z.object({
  availability: offerAvailabilitySchema,
  leadDays: z.number().int(),
  pickup: z.boolean(),
  delivery: z.boolean(),
  warrantyMonths: z.number().int().nullable(),
  warrantyText: z.string().nullable(),
});

export type OrderTerms = z.infer<typeof orderTermsSchema>;

/**
 * Who did something to an order. `member` — an employee of the supplier
 * with their name (`removed` — no longer an employee); only the supplier
 * and the administrator see it — the user's answers never name employees.
 */
export const orderActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({
    kind: z.literal("member"),
    memberId: z.uuid(),
    name: z.string(),
    removed: z.boolean(),
  }),
  z.object({ kind: z.literal("admin"), adminId: z.uuid() }),
  z.object({ kind: z.literal("system") }),
]);

export type OrderActor = z.infer<typeof orderActorSchema>;

/** What an entry of the journal says besides its action (only what applies). */
export const orderEventDetailsSchema = z.object({
  quantity: z.number().int().optional(),
  total: z.number().int().optional(),
  fulfillment: orderFulfillmentSchema.optional(),
  /** The decline: the reason and the employee's note. */
  reason: orderDeclineReasonSchema.optional(),
  note: z.string().optional(),
  /** The deadline that passed (`expire_*`) or is near (`reserve_expiring`). */
  deadline: z.iso.datetime().optional(),
  /** The end of the reserve set by this move (`accept`, `mark_ready`). */
  reserveUntil: z.iso.datetime().optional(),
  /** The receipt date promised on accepting, in the point's time zone. */
  receiptOn: dateSchema.optional(),
  /** `late_action_ignored`: what the employee tried. */
  attemptedAction: orderAttemptedActionSchema.optional(),
  /** `close`, `close_late`, `admin_close`: how the order was given out. */
  closeMethod: orderCloseMethodSchema.optional(),
});

export type OrderEventDetails = z.infer<typeof orderEventDetailsSchema>;

/**
 * One entry of the journal as the supplier and the administrator see it:
 * who (employees by name), when, through which channel and the details.
 */
export const orderEventSchema = z.object({
  id: z.uuid(),
  action: orderEventActionSchema,
  fromStatus: orderStatusSchema.nullable(),
  toStatus: orderStatusSchema.nullable(),
  at: z.iso.datetime(),
  actor: orderActorSchema,
  /**
   * `app` — the mobile app; `supplier_web` — the cabinet; `whatsapp` — a
   * button of a notification (EPIC-09); `admin`; `timer` — a deadline.
   */
  channel: z.enum(["app", "supplier_web", "whatsapp", "admin", "timer"]),
  details: orderEventDetailsSchema,
});

export type OrderEvent = z.infer<typeof orderEventSchema>;

/**
 * How the order was given out, for the supplier and the administrator
 * (S-ORD-02, A-ORD-02): when, by which of the three ways, which employee
 * (`admin` — the administrator, `late` — closed inside the late close
 * window after the reserve had expired). The reason of an administrator's
 * close is internal: only their own view carries it.
 */
export const orderClosureSchema = z.object({
  at: z.iso.datetime(),
  method: orderCloseMethodSchema,
  by: orderActorSchema,
  late: z.boolean(),
});

export type OrderClosure = z.infer<typeof orderClosureSchema>;

/** The same, with the reason the administrator had to give (A-ORD-02). */
export const adminOrderClosureSchema = orderClosureSchema.extend({
  reason: z.string().nullable(),
});

export type AdminOrderClosure = z.infer<typeof adminOrderClosureSchema>;

/**
 * What the user learns about the end of their order (M-ORD-05): that it
 * was given out, when, and whether it was closed after its time had run
 * out. Never which employee did it, never the way and never a reason.
 */
export const orderGivenOutSchema = z.object({ at: z.iso.datetime(), late: z.boolean() });

export type OrderGivenOut = z.infer<typeof orderGivenOutSchema>;

/**
 * The club's own discipline statistics of a user (PRODUCT 10.5; SCREENS
 * A-USR-02, A-USR-03): `pickup_no_show` — the pickup reserve of an order
 * the supplier had accepted ran out and nobody came for the item. It is
 * the administrator's to see: the user is never shown it, it has no effect
 * on the supplier's rating, and there is no public rating of a user.
 */
export const disciplineKindSchema = z.enum(["pickup_no_show"]);

export type DisciplineKind = z.infer<typeof disciplineKindSchema>;

/**
 * Why a mark no longer counts: `late_close` — the supplier gave the order
 * out inside the late close window after all, so the customer had come
 * (PRODUCT 10.7); `admin_close` — the administrator closed the order;
 * `admin` — the administrator lifted the mark by hand, with a reason.
 */
export const disciplineRevocationSchema = z.object({
  at: z.iso.datetime(),
  by: z.enum(["late_close", "admin_close", "admin"]),
  /** The administrator's words; the two automatic reasons have none. */
  note: z.string().nullable(),
  adminId: z.uuid().nullable(),
});

export type DisciplineRevocation = z.infer<typeof disciplineRevocationSchema>;

/** One discipline mark; `revocation` — lifted, and why (A-USR-02: «неявки, в том числе снятые»). */
export const disciplineMarkSchema = z.object({
  id: z.uuid(),
  kind: disciplineKindSchema,
  at: z.iso.datetime(),
  order: z.object({ id: z.uuid(), number: z.number().int() }),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  revocation: disciplineRevocationSchema.nullable(),
});

export type DisciplineMark = z.infer<typeof disciplineMarkSchema>;

/**
 * The course of the order as the user sees it (M-ORD-03 «Ход заявки»):
 * the moves with their time and a side — never an employee's name, never
 * the reason of a decline.
 */
export const userOrderStepSchema = z.object({
  action: orderEventActionSchema,
  status: orderStatusSchema,
  at: z.iso.datetime(),
  by: z.enum(["user", "supplier", "admin", "system"]),
});

export type UserOrderStep = z.infer<typeof userOrderStepSchema>;

const moneyFields = {
  quantity: z.number().int(),
  /** The price of one item when the order was created, whole tenge. */
  unitPrice: z.number().int(),
  /** `unitPrice × quantity` (D-033). */
  total: z.number().int(),
  currency: z.literal("KZT"),
};

const orderBaseFields = {
  id: z.uuid(),
  /** The order's number to say on the phone and to search by («№ 4821»). */
  number: z.number().int(),
  kind: orderKindSchema,
  status: orderStatusSchema,
  /**
   * An order an employee placed with their own company (PRODUCT 12.6):
   * a test order, left out of statistics and the rating.
   */
  isTest: z.boolean(),
  ...moneyFields,
  fulfillment: orderFulfillmentSchema,
  item: orderItemSchema,
  /** The supplier's answer is due by then; after it an order still `created` expires. */
  respondBy: z.iso.datetime(),
  /** The end of the pickup reserve (accepted and ready pickup orders); `null` — none. */
  reserveUntil: z.iso.datetime().nullable(),
  /** The receipt date promised when accepted, in the point's time zone; `null` — not accepted. */
  receiptOn: dateSchema.nullable(),
  createdAt: z.iso.datetime(),
};

// ------------------------------------------------------------------ the user

/** The supplier of the user's own order: named (the order was placed with club access), before accepting — no address. */
export const userOrderSupplierSchema = z.object({
  name: z.string(),
  cityName: z.string(),
  district: z.string().nullable(),
});

/**
 * Where and how to get the item — only once the supplier accepted the
 * order (D-026; M-ORD-03 «Маршрут», «Позвонить»): the address of the
 * pickup point, its hours and upcoming closed dates, the supplier's
 * phone. Current values, not the snapshot: the place to go today.
 */
export const userOrderPickupPointSchema = z.object({
  address: z.string().nullable(),
  district: z.string().nullable(),
  cityName: z.string(),
  timeZone: z.string(),
  /** Seven days, Monday first, `HH:MM` intervals in `timeZone`; `null` — not given. */
  weeklyHours: z.array(dayHoursSchema).nullable(),
  /** Closed dates from today on. */
  closedDates: z.array(z.object({ date: dateSchema, note: z.string().nullable() })),
  /** The supplier's phone; `null` — not given. */
  phone: z.string().nullable(),
});

/**
 * The confirmation code and the QR, for the user only (M-ORD-03, M-ORD-04):
 * `code` — six digits the user says or shows; `qrPayload` — the content of
 * the QR the app draws. Present while the order is active; a final order
 * has none.
 */
export const orderConfirmationSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  qrPayload: z.string(),
});

export type OrderConfirmation = z.infer<typeof orderConfirmationSchema>;

/** The user's order in a list (M-ORD-02): no code, no contacts. */
export const userOrderSummarySchema = z.object({
  ...orderBaseFields,
  supplier: userOrderSupplierSchema,
});

export type UserOrderSummary = z.infer<typeof userOrderSummarySchema>;

/**
 * The user's own order (M-ORD-03). Fields absent for a reason are absent,
 * not empty: `pickupPoint` — until the supplier accepts (and after a
 * cancel, a decline, an expiry); `confirmation` — once the order is final.
 */
export const userOrderSchema = userOrderSummarySchema.extend({
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  terms: orderTermsSchema,
  comment: z.string().nullable(),
  pickupPoint: userOrderPickupPointSchema.optional(),
  confirmation: orderConfirmationSchema.optional(),
  /** The order was given out: when, and whether after its time (PRODUCT 10.7). */
  givenOut: orderGivenOutSchema.nullable(),
  history: z.array(userOrderStepSchema),
});

export type UserOrder = z.infer<typeof userOrderSchema>;

export const orderPathSchema = z.object({ orderId: z.uuid() });

export type OrderPath = z.infer<typeof orderPathSchema>;

/**
 * `POST /orders` (M-ORD-01). `idempotencyKey` — made by the app when the
 * checkout opens: sending the same order again (a double tap, a repeat
 * after a lost answer) returns the order already created, never a second
 * one. `expectedPrice` — the price the user saw: another one now is 409
 * `ORDER_PRICE_CHANGED` («Цена изменилась»). An active order of the user
 * on the same offer is 409 `ORDER_DUPLICATE_ACTIVE` unless
 * `allowAnotherActive` («Оформить ещё одну»).
 */
export const createOrderBodySchema = z.object({
  offerId: z.uuid(),
  quantity: z.number().int().min(1).max(ORDER_QUANTITY_LIMIT).default(1),
  fulfillment: orderFulfillmentSchema,
  comment: multilineText(ORDER_COMMENT_MAX_LENGTH).optional(),
  expectedPrice: z.number().int().min(1).max(OFFER_PRICE_LIMIT),
  idempotencyKey: z.uuid(),
  allowAnotherActive: z.boolean().default(false),
});

export type CreateOrderBody = z.input<typeof createOrderBodySchema>;
export type CreateOrderInput = z.output<typeof createOrderBodySchema>;

/** `created: false` — the same `idempotencyKey` came again: the order made the first time. */
export const createOrderResponseSchema = z.object({
  order: userOrderSchema,
  created: z.boolean(),
});

export type CreateOrderResponse = z.infer<typeof createOrderResponseSchema>;

export const userOrderResponseSchema = z.object({ order: userOrderSchema });

export type UserOrderResponse = z.infer<typeof userOrderResponseSchema>;

/** M-ORD-02: «Активные» (going on) and «История» (final); newest first. */
export const userOrderTabSchema = z.enum(["active", "history"]);

export const userOrderListQuerySchema = z.object({
  tab: userOrderTabSchema.default("active"),
  limit: z.coerce.number().int().min(1).max(ORDER_PAGE_MAX_SIZE).default(ORDER_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type UserOrderListQuery = z.infer<typeof userOrderListQuerySchema>;

export const userOrderPageSchema = z.object({
  language: catalogLanguageSchema,
  orders: z.array(userOrderSummarySchema),
  nextCursor: z.string().nullable(),
});

export type UserOrderPage = z.infer<typeof userOrderPageSchema>;

// -------------------------------------------------------------- the supplier

/**
 * The customer as the supplier sees them: `hidden` until this order is
 * accepted («Телефон откроется после принятия заявки»); `revealed` — the
 * phone number, from accepting on. Only in the card of one order, never in
 * a list. The user's name isn't kept yet (the profile — EPIC-10).
 */
export const orderCustomerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hidden"), reason: z.literal("not_accepted") }),
  z.object({ kind: z.literal("revealed"), phone: z.string() }),
]);

export type OrderCustomer = z.infer<typeof orderCustomerSchema>;

const supplierSideFields = {
  offerId: z.uuid(),
  /** Who accepted or declined the order, and when; `null` — no one yet. */
  handledBy: orderActorSchema.nullable(),
  handledAt: z.iso.datetime().nullable(),
  /** How it was given out — «Закрыта поздно», «Закрыта администратором»; `null` — not given out. */
  closure: orderClosureSchema.nullable(),
};

/** An order in the cabinet's list (S-ORD-01): no customer data, no code. */
export const supplierOrderSummarySchema = z.object({
  ...orderBaseFields,
  ...supplierSideFields,
});

export type SupplierOrderSummary = z.infer<typeof supplierOrderSummarySchema>;

/**
 * The card of an order in the cabinet (S-ORD-02): the terms, the customer
 * by the rule above, the decline and the whole journal with the names of
 * employees. Never the code or the QR.
 */
export const supplierOrderSchema = supplierOrderSummarySchema.extend({
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  terms: orderTermsSchema,
  comment: z.string().nullable(),
  customer: orderCustomerSchema,
  decline: z
    .object({ reason: orderDeclineReasonSchema.nullable(), note: z.string().nullable() })
    .nullable(),
  events: z.array(orderEventSchema),
});

export type SupplierOrder = z.infer<typeof supplierOrderSchema>;

export const supplierOrderResponseSchema = z.object({ order: supplierOrderSchema });

export type SupplierOrderResponse = z.infer<typeof supplierOrderResponseSchema>;

/** The version of the order the employee acted on (what they saw). */
export const orderActionBodySchema = z.object({ expectedVersion: expectedVersionSchema });

export type OrderActionBody = z.infer<typeof orderActionBodySchema>;

/** S-ORD-03: the reason and a note are optional; the user sees neither. */
export const declineOrderBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  reason: orderDeclineReasonSchema.optional(),
  note: freeText(ORDER_DECLINE_NOTE_MAX_LENGTH).optional(),
});

export type DeclineOrderBody = z.infer<typeof declineOrderBodySchema>;

/**
 * The declined order; with «Нет в наличии» and the offer still on sale —
 * `withdrawOffer`: the offer to take off sale if the employee agrees
 * («Снять это предложение с продажи?»; `POST /supplier/offers/{offerId}/withdraw`
 * with this version). Declining never withdraws the offer by itself.
 */
export const declineOrderResponseSchema = z.object({
  order: supplierOrderSchema,
  withdrawOffer: z.object({ offerId: z.uuid(), version: z.number().int() }).nullable(),
});

export type DeclineOrderResponse = z.infer<typeof declineOrderResponseSchema>;

/**
 * S-ORD-01: «Новые» (waiting for an answer, the nearest deadline first),
 * «В работе» (accepted and ready), «Завершённые» (final, newest first).
 */
export const supplierOrderTabSchema = z.enum(["new", "in_progress", "finished"]);

export const supplierOrderListQuerySchema = z.object({
  tab: supplierOrderTabSchema.default("new"),
  limit: z.coerce.number().int().min(1).max(ORDER_PAGE_MAX_SIZE).default(ORDER_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type SupplierOrderListQuery = z.infer<typeof supplierOrderListQuerySchema>;

export const supplierOrderPageSchema = z.object({
  language: catalogLanguageSchema,
  orders: z.array(supplierOrderSummarySchema),
  counts: z.object({
    new: z.number().int(),
    inProgress: z.number().int(),
    finished: z.number().int(),
  }),
  nextCursor: z.string().nullable(),
});

export type SupplierOrderPage = z.infer<typeof supplierOrderPageSchema>;

// ------------------------------------------------- giving an order out (TASK-022)

/**
 * What the customer shows at the counter (S-SCAN-01, S-SCAN-02): exactly
 * one of
 *
 * - `code` — the six digits the customer says or reads off their screen,
 *   with or without the spaces they are shown in («482 915» = «482915»);
 * - `qr` — the content of the scanned QR code, `ADCLUB-ORDER:<токен>`.
 *   Anything else is `ORDER_QR_UNKNOWN` («Это не QR заявки клуба»).
 *
 * The credential travels in the body, never in a path or a query: it is
 * the one secret of the order and belongs in no URL, no log and no cache.
 */
export const orderCredentialSchema = z
  .object({
    code: z.string().min(1).max(32).optional(),
    qr: z.string().min(1).max(300).optional(),
  })
  .refine((body) => (body.code === undefined) !== (body.qr === undefined), {
    message: "Send either a code or the content of a QR",
  });

export type OrderCredential = z.infer<typeof orderCredentialSchema>;

/**
 * The order on the scanner's screen (S-SCAN-03): the item and the
 * quantity, the sum of the order, its status and the way it is to be
 * received. No confirmation code, no QR token, no phone number of the
 * customer — the phone opens in the card of the order once it is accepted
 * (`GET /supplier/orders/{orderId}`), not on a screen reached by typing
 * six digits.
 */
export const supplierScanOrderSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  status: orderStatusSchema,
  version: z.number().int(),
  isTest: z.boolean(),
  ...moneyFields,
  fulfillment: orderFulfillmentSchema,
  item: orderItemSchema,
  receiptOn: dateSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export type SupplierScanOrder = z.infer<typeof supplierScanOrderSchema>;

/** Why an order this credential does point at can't be given out (S-SCAN-04). */
export const orderCloseRefusalSchema = z.enum([
  /** Still waiting for the company's answer: accept it first. */
  "not_accepted",
  /** «Клиент отменил заявку {когда}. Клубная цена по ней не действует». */
  "cancelled_by_user",
  /** The company declined it. */
  "declined_by_supplier",
  /** «Заявка истекла без ответа — закрыть её нельзя» (PRODUCT 10.7). */
  "response_expired",
  /** «Закрыть нельзя: прошло больше {N} часов после истечения». */
  "late_window_passed",
]);

export type OrderCloseRefusalReason = z.infer<typeof orderCloseRefusalSchema>;

/** The cases that are the same whether the employee looked up or closed. */
const settledOutcomes = [
  /** «Заявка уже выдана {at}, закрыл(а) {сотрудник}» — and nothing else. */
  z.object({
    result: z.literal("closed"),
    at: z.iso.datetime(),
    by: orderActorSchema,
    late: z.boolean(),
  }),
  /**
   * Found, and this is not the end of it. `lateCloseHours` — the window of
   * the late close that has passed, for «прошло больше {N} часов».
   */
  z.object({
    result: z.literal("refused"),
    reason: orderCloseRefusalSchema,
    /** When it came to that; `null` — it is simply not accepted yet. */
    at: z.iso.datetime().nullable(),
    lateCloseHours: z.number().int().optional(),
  }),
  /**
   * «Эта заявка оформлена у другого поставщика» — nothing of the order,
   * the customer, the item or the sum. The company is named only when the
   * employee belongs to it too, so the screen can offer to switch.
   */
  z.object({
    result: z.literal("other_supplier"),
    supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  }),
  /** «Код не найден. Проверьте цифры» — and not a word more. */
  z.object({ result: z.literal("not_found") }),
] as const;

/** `POST /supplier/orders/lookup` (S-SCAN-03, S-SCAN-04). */
export const orderLookupResponseSchema = z.discriminatedUnion("result", [
  /** Found, and it may be given out now: «Выдать». */
  z.object({ result: z.literal("ready"), order: supplierScanOrderSchema }),
  /**
   * Found, its pickup reserve expired, and the late close window is still
   * open: «Срок заявки истёк {expiredAt}. Если клиент был у вас вовремя,
   * заявку можно закрыть» (PRODUCT 10.7).
   */
  z.object({
    result: z.literal("late"),
    order: supplierScanOrderSchema,
    expiredAt: z.iso.datetime(),
    /** The window closes then; after that nobody but the administrator closes it. */
    until: z.iso.datetime(),
  }),
  ...settledOutcomes,
]);

export type OrderLookupResponse = z.infer<typeof orderLookupResponseSchema>;

/**
 * `POST /supplier/orders/close` (S-SCAN-04): the order is given out —
 * `given_out` with its card — or the same answer the lookup would give, so
 * one screen shows one message. Giving out an order already given out by
 * this company is no error: the answer is `closed`, and the journal keeps
 * one entry.
 */
export const closeOrderResponseSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("given_out"),
    order: supplierOrderSchema,
    /** Closed inside the late close window (PRODUCT 10.7). */
    late: z.boolean(),
  }),
  ...settledOutcomes,
]);

export type CloseOrderResponse = z.infer<typeof closeOrderResponseSchema>;

// ------------------------------------------------------------ administrator

const adminSideFields = {
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  /** The customer's account and phone number (A-ORD-02 «Клиент»). */
  customer: z.object({ accountId: z.uuid(), phone: z.string() }),
  /** As the supplier's, with the reason an administrator's close carries. */
  closure: adminOrderClosureSchema.nullable(),
};

/** An order in the admin list (A-ORD-01): never the code or the QR. */
export const adminOrderSummarySchema = z.object({
  ...orderBaseFields,
  ...supplierSideFields,
  ...adminSideFields,
});

export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;

/** The card of an order for the administrator (A-ORD-02): everything but the code and the QR. */
export const adminOrderSchema = adminOrderSummarySchema.extend({
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
  terms: orderTermsSchema,
  comment: z.string().nullable(),
  cityName: z.string(),
  phoneRevealedAt: z.iso.datetime().nullable(),
  decline: z
    .object({ reason: orderDeclineReasonSchema.nullable(), note: z.string().nullable() })
    .nullable(),
  /** The discipline marks of this order, lifted ones too (A-ORD-02). */
  discipline: z.array(disciplineMarkSchema),
  events: z.array(orderEventSchema),
});

export type AdminOrder = z.infer<typeof adminOrderSchema>;

/**
 * `POST /admin/orders/{orderId}/close` (A-ORD-02 «Закрыть без кода»,
 * D-043): a disputed order is closed without a code, and only with a
 * reason. It becomes «Выдана», marked «Закрыта администратором» for the
 * supplier and the administrator; the discipline mark of the customer, if
 * any, is lifted. A cancelled, a declined or an already given out order
 * can't be closed this way.
 */
export const adminCloseOrderBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  reason: freeText(ORDER_REASON_MAX_LENGTH),
});

export type AdminCloseOrderBody = z.infer<typeof adminCloseOrderBodySchema>;

export const adminOrderResponseSchema = z.object({ order: adminOrderSchema });

export type AdminOrderResponse = z.infer<typeof adminOrderResponseSchema>;

/**
 * A-ORD-01: by status, supplier, period of creation (`from` inclusive,
 * `to` exclusive), number, «Закрыта поздно» (`closedLate`) and «Закрыта
 * администратором» (`closedByAdmin`); test orders are left out by default
 * (`test=exclude`), shown alone (`only`) or with the others (`include`).
 * Newest first.
 */
export const adminOrderListQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  supplierId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  number: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  test: z.enum(["exclude", "only", "include"]).default("exclude"),
  closedLate: z.enum(["true", "false"]).optional(),
  closedByAdmin: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(ORDER_PAGE_MAX_SIZE).default(ORDER_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

export const adminOrderPageSchema = z.object({
  language: catalogLanguageSchema,
  orders: z.array(adminOrderSummarySchema),
  /** Orders matching the filters. */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminOrderPage = z.infer<typeof adminOrderPageSchema>;

// ------------------------------------------------- discipline (administrator)

/** A-USR-02: the marks of one user or of one order, lifted ones included. */
export const adminDisciplineListQuerySchema = z.object({
  accountId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  /** Leave out to see the lifted ones too. */
  state: z.enum(["all", "standing", "revoked"]).default("all"),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(ORDER_PAGE_MAX_SIZE).default(ORDER_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type AdminDisciplineListQuery = z.infer<typeof adminDisciplineListQuerySchema>;

export const adminDisciplineMarkSchema = disciplineMarkSchema.extend({
  /** Whose mark it is: the account and its phone number (A-USR-02). */
  customer: z.object({ accountId: z.uuid(), phone: z.string() }),
});

export type AdminDisciplineMark = z.infer<typeof adminDisciplineMarkSchema>;

export const adminDisciplinePageSchema = z.object({
  marks: z.array(adminDisciplineMarkSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminDisciplinePage = z.infer<typeof adminDisciplinePageSchema>;

/**
 * A-USR-03 «Неявки»: the users with marks that still stand in the period,
 * the number of them and the last one; most marks first.
 */
export const adminDisciplineUsersQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(ORDER_PAGE_MAX_SIZE).default(ORDER_PAGE_DEFAULT_SIZE),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export type AdminDisciplineUsersQuery = z.infer<typeof adminDisciplineUsersQuerySchema>;

export const adminDisciplineUserSchema = z.object({
  accountId: z.uuid(),
  phone: z.string(),
  /** Marks that still stand in the period. */
  count: z.number().int(),
  /** Marks lifted in the period (they are kept, not deleted). */
  revokedCount: z.number().int(),
  lastAt: z.iso.datetime(),
});

export type AdminDisciplineUser = z.infer<typeof adminDisciplineUserSchema>;

export const adminDisciplineUsersPageSchema = z.object({
  users: z.array(adminDisciplineUserSchema),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
});

export type AdminDisciplineUsersPage = z.infer<typeof adminDisciplineUsersPageSchema>;

export const disciplinePathSchema = z.object({ markId: z.uuid() });

export type DisciplinePath = z.infer<typeof disciplinePathSchema>;

/** A-ORD-02 «Снять дисциплинарную отметку»: only with a reason, and it leaves a trace. */
export const revokeDisciplineBodySchema = z.object({
  reason: freeText(ORDER_REASON_MAX_LENGTH),
});

export type RevokeDisciplineBody = z.infer<typeof revokeDisciplineBodySchema>;

export const adminDisciplineMarkResponseSchema = z.object({ mark: adminDisciplineMarkSchema });

export type AdminDisciplineMarkResponse = z.infer<typeof adminDisciplineMarkResponseSchema>;

// ------------------------------------------------------------------ errors

/**
 * `details` of `ORDER_STATE_CONFLICT` (409): the order is no longer where
 * the action expected it — someone acted first (PRODUCT 12.6: «заявку уже
 * принял Марат в 14:03»), the deadline passed, or the order is final.
 * `lastAction` — who moved it last and how; the supplier and the
 * administrator get it, the user never does.
 */
export const orderStateConflictDetailsSchema = z.object({
  currentStatus: orderStatusSchema,
  version: z.number().int(),
  lastAction: z
    .object({ action: orderEventActionSchema, at: z.iso.datetime(), actor: orderActorSchema })
    .optional(),
});

export type OrderStateConflictDetails = z.infer<typeof orderStateConflictDetailsSchema>;

/** `details` of `ORDER_PRICE_CHANGED` (409): «Цена изменилась: было N ₸, стало M ₸». */
export const orderPriceChangedDetailsSchema = z.object({
  expectedPrice: z.number().int(),
  currentPrice: z.number().int(),
});

export type OrderPriceChangedDetails = z.infer<typeof orderPriceChangedDetailsSchema>;

/**
 * `details` of `ORDER_QR_UNKNOWN` (400): the scanned string is not the QR
 * of a club order («Это не QR заявки клуба»). The string itself is never
 * echoed back.
 */
export const orderQrUnknownDetailsSchema = z.object({ prefix: z.literal(ORDER_QR_PREFIX) });

export type OrderQrUnknownDetails = z.infer<typeof orderQrUnknownDetailsSchema>;

/** `details` of `ORDER_DUPLICATE_ACTIVE` (409): the user's active order on this offer. */
export const orderDuplicateActiveDetailsSchema = z.object({
  existingOrderId: z.uuid(),
  number: z.number().int(),
});

export type OrderDuplicateActiveDetails = z.infer<typeof orderDuplicateActiveDetailsSchema>;
