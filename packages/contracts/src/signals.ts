import { z } from "zod";
import type { CatalogItemListQuery } from "./catalog-items";

/**
 * Signals to the administrator (`admin_signal`, ARCHITECTURE 5.11, 6.5,
 * 6.6, 4.32; SCREENS A-HOME): facts the server noticed and a person has to
 * look at. A signal decides nothing by itself — it is a card on the
 * administrator's home screen (TASK-034) and a row of this list.
 *
 * TASK-022 raises the first two kinds:
 *
 * - `duplicate_after_late_close` — a supplier gave an expired order out
 *   late, and in the meantime the same user had ordered the same item
 *   again: both orders are valid, and somebody should check whether the
 *   item was handed over twice (PRODUCT 10.7);
 * - `frequent_admin_closes` — one supplier has had orders closed by an
 *   administrator without a code more often than the threshold allows
 *   (D-043): either the scanner isn't being used or the orders aren't real.
 *
 * TASK-025 adds `whatsapp_outage` (ARCHITECTURE 6.6; PRODUCT 10.4; SCREENS
 * A-HOME, A-ORD-03): the notices of orders to suppliers stopped reaching
 * them — refused, lost (`unknown`) or not delivered in time — above the
 * thresholds of the settings. The subject is the channel itself, so there
 * is one such signal at a time; it closes by itself when the channel
 * delivers again. The deadlines of orders are never touched by it — the
 * administrator extends them by hand.
 *
 * TASK-034 adds `supplier_unreachable` (D-061; ARCHITECTURE 4.52): every
 * employee of a company who receives the notices of orders has, by the last
 * word about their number, no WhatsApp (`no_whatsapp`) — the company hears
 * of no order at all, and there is no other channel to it. One signal per
 * company; it closes by itself when a message reaches any of them again.
 *
 * Since TASK-034 an administrator takes a signal in work and closes it with
 * a comment (`POST /admin/signals/{id}/acknowledge`, `…/close`), with the
 * version they saw.
 *
 * TASK-037 adds `supply_overdue` (ARCHITECTURE 6.2): an order under order
 * whose confirmed date has passed is still not ready to be given out. One
 * signal per order (the subject is the order), raised once; a test order of
 * an employee raises none (`countsInStatistics`). The status of the order
 * does not change — the administrator calls the supplier.
 *
 * Later tasks add the others (a low rating, a spike of complaints, a failed
 * payment).
 */

export const adminSignalKindSchema = z.enum([
  "duplicate_after_late_close",
  "frequent_admin_closes",
  "whatsapp_outage",
  "supplier_unreachable",
  "supply_overdue",
]);

export type AdminSignalKind = z.infer<typeof adminSignalKindSchema>;

/** What the signal is about: an order, a supplier, or the channel of notices itself. */
export const adminSignalSubjectSchema = z.enum(["order", "supplier", "channel"]);

export type AdminSignalSubject = z.infer<typeof adminSignalSubjectSchema>;

/**
 * The subject id of the WhatsApp channel of notices to suppliers: one
 * channel, one id, so one open signal about it at a time.
 */
export const WHATSAPP_CHANNEL_SUBJECT_ID = "00000000-0000-4000-8000-00000000c4a1";

/**
 * `open` — waiting for a person; `acknowledged` — seen; `closed` — dealt
 * with or gone by itself (the outage of the channel closes itself when the
 * channel delivers again, TASK-025).
 */
export const adminSignalStatusSchema = z.enum(["open", "acknowledged", "closed"]);

export type AdminSignalStatus = z.infer<typeof adminSignalStatusSchema>;

/** Only the fields a kind needs; every one of them is optional. */
export const adminSignalPayloadSchema = z.object({
  /** `duplicate_after_late_close`: the order closed late and the newer one. */
  orderId: z.uuid().optional(),
  orderNumber: z.number().int().optional(),
  otherOrderId: z.uuid().optional(),
  otherOrderNumber: z.number().int().optional(),
  itemId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  supplierName: z.string().optional(),
  /** `frequent_admin_closes`: how many closes in how many days, and the threshold. */
  closes: z.number().int().optional(),
  days: z.number().int().optional(),
  threshold: z.number().int().optional(),
  /**
   * `whatsapp_outage`: when the first notice that did not arrive failed
   * (`since` — where A-ORD-03 starts its list), the latest such failure,
   * how many notices failed since then and of how many judged in the
   * window, of which orders and suppliers, what the failures were, and —
   * once the channel delivers again — when it did (`endedAt`).
   */
  since: z.iso.datetime().optional(),
  lastFailureAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  failedMessages: z.number().int().optional(),
  judgedMessages: z.number().int().optional(),
  affectedOrders: z.number().int().optional(),
  supplierIds: z.array(z.uuid()).optional(),
  failureKinds: z.record(z.string(), z.number().int()).optional(),
  windowMinutes: z.number().int().optional(),
  /**
   * `supplier_unreachable` (TASK-034): how many employees receive the
   * notices of orders, and how many of them have no WhatsApp by the last
   * word about their number; `since`, `lastFailureAt` and `endedAt` — as
   * for the outage, about these numbers.
   */
  recipients: z.number().int().optional(),
  recipientsWithoutWhatsapp: z.number().int().optional(),
  /**
   * `supply_overdue` (TASK-037): the date the goods were promised on (the
   * point's own calendar date) and the confirmed term in working days; the
   * order and its supplier are `orderId`, `orderNumber`, `supplierId`.
   */
  readyOn: z.string().optional(),
  leadDays: z.number().int().optional(),
});

export type AdminSignalPayload = z.infer<typeof adminSignalPayloadSchema>;

/**
 * Who took a signal in work or closed it: an administrator (their name if
 * the account has one, the number partly hidden), or the server itself —
 * the fact was over (TASK-034).
 */
export const adminSignalActorSchema = z.object({
  kind: z.enum(["admin", "system"]),
  adminId: z.uuid().nullable(),
  name: z.string().nullable(),
  /** `+7***1234`; `null` for the server. */
  phoneMasked: z.string().nullable(),
});

export type AdminSignalActor = z.infer<typeof adminSignalActorSchema>;

export const adminSignalSchema = z.object({
  id: z.uuid(),
  kind: adminSignalKindSchema,
  subjectType: adminSignalSubjectSchema,
  subjectId: z.uuid(),
  status: adminSignalStatusSchema,
  payload: adminSignalPayloadSchema,
  /** How many times the same fact came up again (one row, not a pile). */
  times: z.number().int(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /** When the signal was closed; `null` — it is not. */
  closedAt: z.iso.datetime().nullable(),
  /**
   * TASK-034. Send it back as `expectedVersion`: it grows when the signal
   * is taken in work or closed (not when the same fact comes up again —
   * that only refreshes the payload and `times`).
   */
  version: z.number().int(),
  acknowledgedAt: z.iso.datetime().nullable(),
  acknowledgedBy: adminSignalActorSchema.nullable(),
  /** Who closed it; `null` — not closed. */
  closedBy: adminSignalActorSchema.nullable(),
  /** The administrator's comment at the close; `null` — not closed by an administrator. */
  closeComment: z.string().nullable(),
});

export type AdminSignal = z.infer<typeof adminSignalSchema>;

/**
 * `status` of the list: one of the statuses, or `current` — every signal
 * that is not closed (new and in work), the default view of A-SIG.
 */
export const adminSignalStatusFilterSchema = z.enum(["open", "acknowledged", "closed", "current"]);

export type AdminSignalStatusFilter = z.infer<typeof adminSignalStatusFilterSchema>;

export const adminSignalListQuerySchema = z.object({
  kind: adminSignalKindSchema.optional(),
  status: adminSignalStatusFilterSchema.optional(),
  subjectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export type AdminSignalListQuery = z.infer<typeof adminSignalListQuerySchema>;

export const adminSignalPageSchema = z.object({
  signals: z.array(adminSignalSchema),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
});

export type AdminSignalPage = z.infer<typeof adminSignalPageSchema>;

export const adminSignalIdPathSchema = z.object({
  signalId: z.uuid(),
});

export type AdminSignalIdPath = z.infer<typeof adminSignalIdPathSchema>;

/** `POST /admin/signals/{signalId}/acknowledge` — «Взять в работу» a new signal. */
export const acknowledgeAdminSignalBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export type AcknowledgeAdminSignalBody = z.infer<typeof acknowledgeAdminSignalBodySchema>;

/**
 * `POST /admin/signals/{signalId}/close` — «Закрыть с комментарием» a new
 * signal or one in work. The comment is required (3–1000 characters, not
 * counting spaces at the ends) and goes into the action journal.
 */
export const closeAdminSignalBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  comment: z.string().trim().min(3).max(1000),
});

export type CloseAdminSignalBody = z.infer<typeof closeAdminSignalBodySchema>;

export const adminSignalResponseSchema = z.object({
  signal: adminSignalSchema,
});

export type AdminSignalResponse = z.infer<typeof adminSignalResponseSchema>;

/** `details` of `SIGNAL_CONFLICT`: the signal as it is now. */
export const adminSignalConflictDetailsSchema = z.object({
  signal: adminSignalSchema,
});

export type AdminSignalConflictDetails = z.infer<typeof adminSignalConflictDetailsSchema>;

/**
 * The filters of `GET /admin/catalog/items` behind each counter of the
 * catalog's quality on the home screen (TASK-035): the server counts the
 * list's `total` with exactly these, and the card opens the list with them —
 * one place, so the number on the card and the rows of the list agree.
 */
export const adminHomeCatalogFilters = {
  withoutPhoto: { status: "active", withoutPhoto: "true" },
  incomplete: { status: "active", completeness: "incomplete" },
  withoutCompatibility: { status: "active", withoutCompatibility: "true" },
  itemsWithoutTranslation: { status: "active", withoutTranslation: "true" },
} as const satisfies Record<string, Partial<Record<keyof CatalogItemListQuery, string>>>;

/**
 * `GET /admin/home` (TASK-034, SCREENS A-HOME): the counters of the
 * administrator's queue of attention in one answer, in the order of
 * importance. Each counter is what the list it leads to would show.
 */
export const adminHomeSchema = z.object({
  /**
   * The outage of the WhatsApp channel of notices (1, highlighted): the
   * current signal, `null` — the channel works.
   */
  channelOutage: z
    .object({
      signalId: z.uuid(),
      status: adminSignalStatusSchema,
      since: z.iso.datetime().nullable(),
      affectedOrders: z.number().int(),
      failedMessages: z.number().int(),
    })
    .nullable(),
  /** Signals that are not closed, by kind (2): every kind, zeros too. */
  signals: z.array(
    z.object({
      kind: adminSignalKindSchema,
      open: z.number().int(),
      acknowledged: z.number().int(),
    }),
  ),
  /** The AI budget of today (Almaty) — «исчерпан бюджет ИИ» (2). */
  aiBudget: z.object({
    exhausted: z.boolean(),
    spentUsd: z.number(),
    budgetUsd: z.number(),
  }),
  /** New connection requests of suppliers (7): `GET /admin/supplier-leads?status=new`. */
  newSupplierLeads: z.number().int(),
  /** The quality of the catalog (8). Items that are not archived. */
  catalog: z.object({
    /** No approved photo. */
    withoutPhoto: z.number().int(),
    /** `completeness=incomplete` (`GET /admin/catalog/items`). */
    incomplete: z.number().int(),
    /**
     * Parts and goods of a subcategory where compatibility is required, with
     * no approved compatibility record — the client catalog doesn't show them.
     */
    withoutCompatibility: z.number().int(),
    /**
     * Texts with no translation into a language: `missing` and `failed` of
     * `GET /admin/translations` (waiting ones are on their way).
     */
    withoutTranslation: z.number().int(),
    /**
     * Active items whose name lacks a Kazakh or English text with
     * none on its way — the number of rows of `GET /admin/catalog/items`
     * with `withoutTranslation=true&status=active` (TASK-035).
     */
    itemsWithoutTranslation: z.number().int(),
  }),
  /** When the counters were taken. */
  at: z.iso.datetime(),
});

export type AdminHome = z.infer<typeof adminHomeSchema>;
