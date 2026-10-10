import { z } from "zod";
import { carColorIdSchema, carLevelValueSchema } from "./garage";

/**
 * A car read off a photographed Kazakhstan vehicle registration
 * certificate — СРТС (D-064, TASK-057; SCREENS M-GAR-04, M-GAR-05).
 *
 * The photo travels in the body of one request and is gone when the answer
 * is: the server makes it smaller, strips what came with it, hands it to the
 * AI gateway and answers with the fields — the picture is stored nowhere.
 * What the answer carries is what a person checks before anything is saved:
 * nothing is added to the garage by this route.
 *
 * The certificate says the make and model as written, the year, the VIN,
 * the plate, the engine size and the colour; it does not say the body, the
 * transmission, the drive or the engine code — those are asked by the steps
 * (M-GAR-03). The owner, the address, the series and the number of the
 * certificate are never read out and never sent back.
 */

/** What the server takes as the body: a photo, by content (anything else is `VEHICLE_DOCUMENT_INVALID`). */
export const VEHICLE_DOCUMENT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** The most the server reads of a body at all; `vehicle_document_max_size_mb` is the real limit below it. */
export const VEHICLE_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/** The longest side of the picture the server sends on; the app makes it this small before sending. */
export const VEHICLE_DOCUMENT_MAX_SIDE_PX = 1600;

/**
 * `deviceId` — made by the app once per installation, sent by a guest: a
 * guest's trial recognitions are counted per device (PRODUCT 6.6). A
 * signed-in person's are counted per account, and the id is ignored.
 */
export const vehicleDocumentQuerySchema = z.object({
  deviceId: z.uuid().optional(),
});

export type VehicleDocumentQuery = z.infer<typeof vehicleDocumentQuerySchema>;

/**
 * - `kz_registration` — a Kazakhstan registration certificate (the old or
 *   the new form): the fields below are read;
 * - `other_document` — a document, but not that one (a driving licence, a
 *   Russian certificate): no field is read from it;
 * - `unreadable` — nothing could be read (blurred, cut off, not a document).
 */
export const vehicleDocumentKindSchema = z.enum([
  "kz_registration",
  "other_document",
  "unreadable",
]);

export type VehicleDocumentKind = z.infer<typeof vehicleDocumentKindSchema>;

/** The fields as they are written in the document, checked: a VIN and a plate that don't fit are `null`. */
export const vehicleDocumentFieldsSchema = z.object({
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  /** 17 characters without I, O, Q, upper case — or `null`, never a guess. */
  vin: z.string().nullable(),
  /** Compact, `123ABC02` / `A123BCD`; shown as `123 ABC 02`. */
  plate: z.string().nullable(),
  /** cm³, e.g. 1477. */
  engineVolumeCc: z.number().int().nullable(),
  /** As written, e.g. «БЕЛЫЙ». */
  color: z.string().nullable(),
});

export type VehicleDocumentFields = z.infer<typeof vehicleDocumentFieldsSchema>;

/**
 * How a field found its place in the vehicle catalog: `exact` — one value,
 * taken as chosen (`value`); `candidates` — several fit, the step asks among
 * them (`candidates`, put first); `not_found` — nothing fits, the step asks
 * as usual and says «Распознали „…“ — выберите из списка».
 */
export const vehicleDocumentMatchStatusSchema = z.enum(["exact", "candidates", "not_found"]);

export type VehicleDocumentMatchStatus = z.infer<typeof vehicleDocumentMatchStatusSchema>;

export const vehicleDocumentLevelMatchSchema = z.object({
  status: vehicleDocumentMatchStatusSchema,
  value: carLevelValueSchema.nullable(),
  candidates: z.array(carLevelValueSchema),
});

export type VehicleDocumentLevelMatch = z.infer<typeof vehicleDocumentLevelMatchSchema>;

export const vehicleDocumentMatchSchema = z.object({
  make: vehicleDocumentLevelMatchSchema,
  model: vehicleDocumentLevelMatchSchema,
  /** The generations of the model the year falls into. */
  generation: vehicleDocumentLevelMatchSchema,
  /** The engines of the model's modifications of that size — always to choose among, the document has no code. */
  engine: vehicleDocumentLevelMatchSchema,
  /** The colour of the fixed list (D-063). */
  color: z.object({
    status: z.enum(["exact", "not_found"]),
    value: carColorIdSchema.nullable(),
  }),
});

export type VehicleDocumentMatch = z.infer<typeof vehicleDocumentMatchSchema>;

/**
 * How many recognitions are left: a guest's trial ones on this device
 * (T-GAR-04), or a signed-in person's for the day. `scope` says which.
 */
export const vehicleDocumentAttemptsSchema = z.object({
  scope: z.enum(["guest", "account"]),
  remaining: z.number().int(),
  limit: z.number().int(),
});

export type VehicleDocumentAttempts = z.infer<typeof vehicleDocumentAttemptsSchema>;

export const vehicleDocumentResponseSchema = z.object({
  result: vehicleDocumentKindSchema,
  /** All `null` unless `result` is `kz_registration`. */
  fields: vehicleDocumentFieldsSchema,
  match: vehicleDocumentMatchSchema,
  /**
   * Signed by the server when a certificate was read: the car saved with it
   * is marked «документ показан» with this moment (`documentProof` of the
   * garage routes). `null` for anything else.
   */
  documentProof: z.string().nullable(),
  attempts: vehicleDocumentAttemptsSchema,
});

export type VehicleDocumentResponse = z.infer<typeof vehicleDocumentResponseSchema>;

/** `details.reason` of `VEHICLE_DOCUMENT_INVALID`. */
export const vehicleDocumentInvalidReasonSchema = z.enum([
  "not_an_image",
  "unsupported_format",
  "broken",
  "too_many_pixels",
]);

export const vehicleDocumentInvalidDetailsSchema = z.object({
  reason: vehicleDocumentInvalidReasonSchema,
});

/**
 * `details` of `VEHICLE_DOCUMENT_UNAVAILABLE`: `provider` — the AI provider
 * can't be reached; `budget` — the day's AI budget is spent. The attempt
 * was not counted.
 */
export const vehicleDocumentUnavailableDetailsSchema = z.object({
  reason: z.enum(["provider", "budget"]),
  attempts: vehicleDocumentAttemptsSchema,
});

export type VehicleDocumentUnavailableDetails = z.infer<
  typeof vehicleDocumentUnavailableDetailsSchema
>;
