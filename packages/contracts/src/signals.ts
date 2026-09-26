import { z } from "zod";

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
 * Later tasks add the others (a low rating, a spike of complaints, a failed
 * payment).
 */

export const adminSignalKindSchema = z.enum([
  "duplicate_after_late_close",
  "frequent_admin_closes",
  "whatsapp_outage",
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
});

export type AdminSignalPayload = z.infer<typeof adminSignalPayloadSchema>;

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
});

export type AdminSignal = z.infer<typeof adminSignalSchema>;

export const adminSignalListQuerySchema = z.object({
  kind: adminSignalKindSchema.optional(),
  status: adminSignalStatusSchema.optional(),
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
