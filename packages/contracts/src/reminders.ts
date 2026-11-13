import { z } from "zod";
import { localizedTextSchema } from "./catalog";
import { maintenanceCatalogSchema, maintenanceItemKindSchema } from "./maintenance";

/**
 * Reminders about a planned replacement (TASK-069; PRODUCT 6.5; SCREENS
 * M-REM-01, M-REM-02, M-PRO-04, P-REM-01/02; D-038; ARCHITECTURE 4.87).
 * Only for a signed-in user's garage; everything is counted by the server
 * with one rule (`reminderState` of `@adclub/domain`) — the app shows what
 * it is sent.
 */

/** What a reminder of an element is now. */
export const reminderStateSchema = z.enum(["due", "snoozed", "waiting", "unknown"]);
export type ReminderStateValue = z.infer<typeof reminderStateSchema>;

/** What the count of an element is from: an order, «Уже поменял», the plan's schedule. */
export const reminderBasisSourceSchema = z.enum(["order", "user", "schedule"]);
export type ReminderBasisSource = z.infer<typeof reminderBasisSourceSchema>;

export const garageReminderSchema = z.object({
  /** The element of the car's active maintenance plan. */
  planItemId: z.uuid(),
  title: localizedTextSchema,
  kind: maintenanceItemKindSchema,
  state: reminderStateSchema,
  /** What made it due: the mileage or the date; `null` — not due. */
  reason: z.enum(["km", "date"]).nullable(),
  intervalKm: z.number().int().nullable(),
  intervalMonths: z.number().int().nullable(),
  /** «прошло около N км» since the last replacement; `null` — unknown. */
  elapsedKm: z.number().int().nullable(),
  /** «прошло N месяцев»; `null` — unknown. */
  elapsedMonths: z.number().int().nullable(),
  /** When it is due: the mileage and the moment; `null` — not by that. */
  dueKm: z.number().int().nullable(),
  dueAt: z.iso.datetime().nullable(),
  basis: z.object({
    source: reminderBasisSourceSchema,
    atKm: z.number().int().nullable(),
    at: z.iso.datetime().nullable(),
    /** «по заявке № N». */
    orderId: z.uuid().nullable(),
    orderNumber: z.number().int().nullable(),
  }),
  snoozedUntil: z.iso.datetime().nullable(),
  /**
   * «Подобрать» — the subcategory with the rule's filters for this car and
   * the person's city, as `GET /maintenance/plan` answers it (the client
   * list counts it). `null` in the admin panel's view.
   */
  catalog: maintenanceCatalogSchema.nullable(),
});
export type GarageReminder = z.infer<typeof garageReminderSchema>;

export const garageReminderCarSchema = z.object({
  carId: z.uuid(),
  /** The car has an active maintenance plan (without one — no reminders and no question). */
  hasPlan: z.boolean(),
  /** M-REM-02: ask the mileage. */
  askMileage: z.boolean(),
  lastMileageKm: z.number().int().nullable(),
  lastMileageAt: z.iso.datetime().nullable(),
  /** The mileage counted on — the estimate by the average daily mileage, or the last reading. */
  currentKm: z.number().int().nullable(),
  estimated: z.boolean(),
  /** Every element of the plan, in its order. */
  reminders: z.array(garageReminderSchema),
  /** M-REM-01: the one card — the most overdue due element; `null` — nothing due. */
  topPlanItemId: z.uuid().nullable(),
});
export type GarageReminderCar = z.infer<typeof garageReminderCarSchema>;

/** `GET /garage/reminders`. */
export const garageRemindersResponseSchema = z.object({
  /** M-PRO-04 «Напоминания о замене»; `false` — no cards and no question (`cars` is empty). */
  enabled: z.boolean(),
  cars: z.array(garageReminderCarSchema),
});
export type GarageRemindersResponse = z.infer<typeof garageRemindersResponseSchema>;

export const garageReminderPathSchema = z.object({
  carId: z.uuid(),
  planItemId: z.uuid(),
});
export type GarageReminderPath = z.infer<typeof garageReminderPathSchema>;

/**
 * «Уже поменял» (D-038): the replacement is marked at the current mileage;
 * `mileageKm` — the person corrected it: first written to the journal by
 * the way of TASK-058 (lower than the last only with `confirmLower`).
 */
export const garageReminderDoneBodySchema = z.object({
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
  confirmLower: z.boolean().optional(),
});
export type GarageReminderDoneBody = z.infer<typeof garageReminderDoneBodySchema>;
