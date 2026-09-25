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
 * Later tasks add the others (a low rating, the WhatsApp outage of 6.6, a
 * spike of complaints, a failed payment).
 */

export const adminSignalKindSchema = z.enum([
  "duplicate_after_late_close",
  "frequent_admin_closes",
]);

export type AdminSignalKind = z.infer<typeof adminSignalKindSchema>;

/** What the signal is about: an order or a supplier. */
export const adminSignalSubjectSchema = z.enum(["order", "supplier"]);

export type AdminSignalSubject = z.infer<typeof adminSignalSubjectSchema>;

/**
 * `open` — waiting for a person; `acknowledged` — seen; `closed` — dealt
 * with or gone by itself. Only `open` is raised by this task.
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
