import { z } from "zod";

/**
 * The account's own garage (PRODUCT 6.4, 6.6; SCREENS M-GAR-01…06; TASK-029,
 * ARCHITECTURE 4.41): once someone is signed in, the account is the source
 * of truth for their cars, not the device (the device keeps a copy for
 * offline viewing — mobile side, not this contract).
 *
 * A car is described exactly as the mobile garage already describes one
 * (mobile ARCHITECTURE 4.38 I397, TASK-028): eight levels of the vehicle
 * catalog, each either a chosen id with the label that was shown, or `null`
 * when the level was never asked — plus the optional colour (D-063), which
 * takes no part in deciding whether two cars are the same one.
 */

export const carLevelValueSchema = z.object({
  id: z.uuid(),
  /** The label shown when this level was chosen — display only. */
  label: z.string().min(1).max(200),
});

export type CarLevelValue = z.infer<typeof carLevelValueSchema>;

/** Every level of a car; make and model always known, the rest optional. */
export const carLevelsSchema = z.object({
  make: carLevelValueSchema,
  model: carLevelValueSchema,
  year: z.number().int().min(1950).max(2100).nullable(),
  generation: carLevelValueSchema.nullable(),
  body: carLevelValueSchema.nullable(),
  engine: carLevelValueSchema.nullable(),
  transmission: carLevelValueSchema.nullable(),
  drive: carLevelValueSchema.nullable(),
});

export type CarLevels = z.infer<typeof carLevelsSchema>;

/** D-063: a fixed list, kept in application code (here), not the vehicle catalog. The app adds only the swatches. */
export const CAR_COLOR_IDS = [
  "white",
  "black",
  "gray",
  "silver",
  "blue",
  "darkBlue",
  "red",
  "green",
  "brown",
  "beige",
  "orange",
  "yellow",
  "burgundy",
] as const;

export const carColorIdSchema = z.enum(CAR_COLOR_IDS);

export type CarColorId = z.infer<typeof carColorIdSchema>;

/** One car of the account's garage, as every read of it answers. */
export const accountCarSchema = z.object({
  id: z.uuid(),
  ...carLevelsSchema.shape,
  /** Known only when the levels named exactly one modification. */
  modificationId: z.uuid().nullable(),
  color: carColorIdSchema.nullable(),
  /** The car the catalog filters by (M-GAR-01 «Основной»). */
  isPrimary: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AccountCar = z.infer<typeof accountCarSchema>;

/** `GET /garage/cars`: every car of the signed-in account, most recently added first. */
export const garageCarsResponseSchema = z.object({
  cars: z.array(accountCarSchema),
});

export type GarageCarsResponse = z.infer<typeof garageCarsResponseSchema>;

/**
 * The exact modification the levels named, when they named exactly one
 * (TASK-029.B): kept next to the levels, not inside them, because it is not
 * a level of the rule «the same car» (ARCHITECTURE 4.41 I435) — two cars
 * with the same levels are the same car whatever the device worked out.
 * Optional so a client that never sends it keeps working; absent — `null`.
 */
const modificationIdField = z.uuid().nullable().optional();

/** `PATCH /garage/cars/{carId}`: the levels, the colour and the modification. */
export const saveGarageCarBodySchema = z.object({
  levels: carLevelsSchema,
  modificationId: modificationIdField,
  color: carColorIdSchema.nullable(),
});

export type SaveGarageCarBody = z.infer<typeof saveGarageCarBodySchema>;

/**
 * `POST /garage/cars`: the same as a change, plus `idempotencyKey` — made by
 * the app once per adding (TASK-029.B): the same key again, after an answer
 * was lost on the way, gives back the car the first request added instead
 * of a second one (ARCHITECTURE 4.46). Optional: without it every request
 * adds a car, as before.
 */
export const addGarageCarBodySchema = saveGarageCarBodySchema.extend({
  idempotencyKey: z.uuid().optional(),
});

export type AddGarageCarBody = z.infer<typeof addGarageCarBodySchema>;

export const garageCarIdPathSchema = z.object({ carId: z.uuid() });

export type GarageCarIdPath = z.infer<typeof garageCarIdPathSchema>;

/** `DELETE /garage/cars/{carId}`. */
export const garageCarRemovedResponseSchema = z.object({ removed: z.literal(true) });

export type GarageCarRemovedResponse = z.infer<typeof garageCarRemovedResponseSchema>;

/**
 * `POST /garage/transfer` (SCREENS "Перенос гостевого гаража", TASK-029
 * requirement 2, 5): the device sends every car of its guest garage; the
 * server merges them into the account's own garage without duplicates (the
 * one rule of "same car" — only the levels, never the colour) and answers
 * with the account's garage as it stands afterward. Calling it again with
 * the same cars changes nothing (idempotent) — a device that failed to
 * record success and retries does not create a second copy.
 *
 * `isPrimary` marks the car that was the device's own main one; if the
 * account does not already have a primary car, that one becomes it
 * (multiple `true` — the first is taken, the rest ignored: a well-behaved
 * device sends at most one).
 */
export const transferGarageBodySchema = z.object({
  cars: z
    .array(
      z.object({
        levels: carLevelsSchema,
        modificationId: modificationIdField,
        color: carColorIdSchema.nullable(),
        isPrimary: z.boolean(),
      }),
    )
    // The ceiling of `garage_max_cars` (500): the setting is the real limit, and a
    // transfer past it is cut there, not refused; this only bounds the body.
    .max(500),
});

export type TransferGarageBody = z.infer<typeof transferGarageBodySchema>;

export const transferGarageResponseSchema = z.object({
  cars: z.array(accountCarSchema),
  /** How many of the submitted cars were new to the account — 0 means only duplicates. */
  transferred: z.number().int(),
});

export type TransferGarageResponse = z.infer<typeof transferGarageResponseSchema>;
