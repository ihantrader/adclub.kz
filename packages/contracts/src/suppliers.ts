import { z } from "zod";
import { catalogLanguageSchema, localizedTextSchema } from "./catalog";

/**
 * Suppliers and how they come to the club (PRODUCT 12.1, 13, 14; SCREENS
 * S-PUB-01, A-SUP-01…04; ARCHITECTURE 5.5, 4.26; TASK-016): the directory
 * of cities, connection requests from the public form and the funnel the
 * administrator works them through, creating a supplier with its pickup
 * point and first employee, the supplier's card (address, district, hours,
 * days off) and its states — verified partner, pause, blocking.
 *
 * Enum values here are only ever added (ARCHITECTURE 7.4).
 */

export const SUPPLIER_NAME_MAX_LENGTH = 200;
export const SUPPLIER_CONTACT_NAME_MAX_LENGTH = 100;
export const SUPPLIER_ADDRESS_MAX_LENGTH = 300;
export const SUPPLIER_DISTRICT_MAX_LENGTH = 100;
export const SUPPLIER_NOTE_MAX_LENGTH = 2000;
export const SUPPLIER_REASON_MAX_LENGTH = 500;
export const SUPPLIER_PAGE_MAX_SIZE = 100;
export const SUPPLIER_PAGE_DEFAULT_SIZE = 50;
export const CITY_NAME_MAX_LENGTH = 60;
/** Hours of one day: up to three intervals (a lunch break and a late shift). */
export const SUPPLIER_DAY_INTERVALS_MAX = 3;
/** Days off listed ahead at most (a year of them). */
export const SUPPLIER_CLOSED_DATES_MAX = 366;
export const SUPPLIER_CLOSED_DATE_NOTE_MAX_LENGTH = 200;
/** The default time zone of a city and of a supplier: all of Kazakhstan since 2024. */
export const DEFAULT_TIME_ZONE = "Asia/Almaty";

const expectedVersionSchema = z.number().int().min(1);

function plainText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { message: "Must not be empty" })
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });
}

const reasonSchema = z
  .string()
  .trim()
  .min(3, { message: "Say why in a few words" })
  .max(SUPPLIER_REASON_MAX_LENGTH)
  .regex(/^[^\p{Cc}]*$/u, { message: "Must not contain control characters" });

const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(SUPPLIER_PAGE_MAX_SIZE)
  .default(SUPPLIER_PAGE_DEFAULT_SIZE);

/** The `nextCursor` of the previous page: the only way to ask for the next one. */
const cursorSchema = z.string().min(1).max(300);

/**
 * A phone number as people type it; the server accepts only a Kazakhstan
 * mobile number and normalizes it to `+77XXXXXXXXX` (as at sign-in).
 */
const phoneInputSchema = z.string().trim().min(1).max(32);

/**
 * A БИН (or the ИИН of a sole proprietor) as people type it; the server
 * drops spaces and dashes and checks the 12 digits and the check digit —
 * `VALIDATION_ERROR` on `bin` otherwise.
 */
const binInputSchema = z.string().trim().min(1).max(32);

/** An IANA time zone, e.g. `Asia/Almaty`; the server accepts only one it knows. */
const timeZoneSchema = z.string().trim().min(3).max(64);

/** A calendar date, `YYYY-MM-DD`. */
const dateSchema = z.iso.date();

// ----------------------------------------------------------------- cities

/** A stable code (`almaty`, `ust-kamenogorsk`); never changes when the city is renamed. */
export const cityCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{1,49}$/, {
  message: "Must be a lowercase latin code of 2–50 characters (letters, digits, dashes)",
});

/** `archived` — not offered for a new choice; whoever chose it keeps it. No deletion. */
export const cityStatusSchema = z.enum(["active", "archived"]);

export type CityStatus = z.infer<typeof cityStatusSchema>;

/**
 * How a city came to be: `manual` — the administrator or the development
 * seed; `migrated` — made from the city text of a company created before
 * the directory (TASK-016); `operator` — the development operator command.
 */
export const citySourceSchema = z.enum(["manual", "migrated", "operator"]);

export type CitySource = z.infer<typeof citySourceSchema>;

/** Names by language, written by hand (never translated automatically); Russian is always there. */
export const cityNamesSchema = z.object({
  ru: z.string(),
  kk: z.string().nullable(),
  en: z.string().nullable(),
});

export type CityNames = z.infer<typeof cityNamesSchema>;

export const adminCitySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  names: cityNamesSchema,
  timeZone: z.string(),
  sort: z.number().int(),
  status: cityStatusSchema,
  source: citySourceSchema,
  /** The city of the setting `default_city`. */
  isDefault: z.boolean(),
  version: z.number().int(),
  archivedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export type AdminCity = z.infer<typeof adminCitySchema>;

export const cityIdPathSchema = z.object({ cityId: z.uuid() });

export type CityIdPath = z.infer<typeof cityIdPathSchema>;

export const adminCityListResponseSchema = z.object({
  /** In their order, archived ones included. */
  cities: z.array(adminCitySchema),
});

export type AdminCityListResponse = z.infer<typeof adminCityListResponseSchema>;

/**
 * A new city goes last. A name is unique among all cities in each
 * language, case ignored (409 `CITY_DUPLICATE`), and so is the code.
 */
export const createCityBodySchema = z.object({
  code: cityCodeSchema,
  names: z.object({
    ru: plainText(CITY_NAME_MAX_LENGTH),
    kk: plainText(CITY_NAME_MAX_LENGTH).nullable().optional(),
    en: plainText(CITY_NAME_MAX_LENGTH).nullable().optional(),
  }),
  /** Default `Asia/Almaty`. */
  timeZone: timeZoneSchema.optional(),
});

export type CreateCityBody = z.infer<typeof createCityBodySchema>;

/** A language left out stays; `null` clears Kazakh or English. The code never changes. */
export const updateCityBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  names: z
    .object({
      ru: plainText(CITY_NAME_MAX_LENGTH).optional(),
      kk: plainText(CITY_NAME_MAX_LENGTH).nullable().optional(),
      en: plainText(CITY_NAME_MAX_LENGTH).nullable().optional(),
    })
    .optional(),
  timeZone: timeZoneSchema.optional(),
});

export type UpdateCityBody = z.infer<typeof updateCityBodySchema>;

export const setCityStatusBodySchema = z.object({
  status: cityStatusSchema,
  expectedVersion: expectedVersionSchema,
});

export type SetCityStatusBody = z.infer<typeof setCityStatusBodySchema>;

/** Every city exactly once, in the new order (409 `CITY_ORDER_MISMATCH` otherwise). */
export const reorderCitiesBodySchema = z.object({
  cityIds: z.array(z.uuid()).min(1).max(1000),
});

export type ReorderCitiesBody = z.infer<typeof reorderCitiesBodySchema>;

export const adminCityResponseSchema = z.object({ city: adminCitySchema });

export type AdminCityResponse = z.infer<typeof adminCityResponseSchema>;

/** A city as a client chooses it. */
export const clientCitySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  /** In the language of the request; without it — Russian, `isFallback: true`. */
  name: localizedTextSchema,
  timeZone: z.string(),
});

export type ClientCity = z.infer<typeof clientCitySchema>;

/** `GET /cities`: active cities in their order, for guests and every session. */
export const cityListResponseSchema = z.object({
  language: catalogLanguageSchema,
  /**
   * The city to start with when none is chosen or detected (the setting
   * `default_city`); `null` — no active city at all.
   */
  defaultCityId: z.uuid().nullable(),
  cities: z.array(clientCitySchema),
});

export type CityListResponse = z.infer<typeof cityListResponseSchema>;

/** A city as the admin panel shows it next to a request or a supplier. */
export const cityRefSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  names: cityNamesSchema,
  status: cityStatusSchema,
});

export type CityRef = z.infer<typeof cityRefSchema>;

// ------------------------------------------------------ connection requests

/** What a supplier offers: goods, services or both (S-PUB-01 «можно оба»). */
export const supplierTypeSchema = z.enum(["goods", "services", "both"]);

export type SupplierType = z.infer<typeof supplierTypeSchema>;

/**
 * The funnel (ARCHITECTURE 4.26): `new → contacted → meeting →
 * contract_signed`, then `onboarded` (only by creating the supplier from
 * the request) or `rejected` (with a reason; may be taken back into work).
 */
export const supplierLeadStatusSchema = z.enum([
  "new",
  "contacted",
  "meeting",
  "contract_signed",
  "onboarded",
  "rejected",
]);

export type SupplierLeadStatusValue = z.infer<typeof supplierLeadStatusSchema>;

/** `public_form` — the public page (S-PUB-01); `admin` — added by hand after a call. */
export const supplierLeadSourceSchema = z.enum(["public_form", "admin"]);

export type SupplierLeadSource = z.infer<typeof supplierLeadSourceSchema>;

/**
 * `POST /supplier-leads` — the public form, without signing in. Every
 * accepted request gets the same answer, whether the company or its БИН
 * is already known or not.
 */
export const submitSupplierLeadBodySchema = z.object({
  companyName: plainText(SUPPLIER_NAME_MAX_LENGTH),
  bin: binInputSchema,
  /** An active city of `GET /cities`. */
  cityId: z.uuid(),
  type: supplierTypeSchema,
  contactName: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH),
  /** A Kazakhstan mobile number («+7 7…»). */
  phone: phoneInputSchema,
  /** Consent to the processing of personal data: the form can't be sent without it. */
  consent: z.literal(true, { message: "Consent to the processing of personal data is required" }),
  /** The language of the form; default — `Accept-Language`. */
  language: catalogLanguageSchema.optional(),
  /**
   * Must stay empty: the form hides it from people. A request with it
   * filled gets the usual answer and is dropped.
   */
  website: z.string().max(500).optional(),
});

export type SubmitSupplierLeadBody = z.infer<typeof submitSupplierLeadBodySchema>;

/** «Заявка отправлена. Мы свяжемся с вами по телефону» — the only answer an accepted form gets. */
export const supplierLeadReceivedResponseSchema = z.object({
  status: z.literal("received"),
});

export type SupplierLeadReceivedResponse = z.infer<typeof supplierLeadReceivedResponseSchema>;

export const adminSupplierLeadSchema = z.object({
  id: z.uuid(),
  companyName: z.string(),
  bin: z.string(),
  city: cityRefSchema,
  type: supplierTypeSchema,
  contactName: z.string(),
  /** `+77XXXXXXXXX`: the administrator calls it. */
  phone: z.string(),
  source: supplierLeadSourceSchema,
  status: supplierLeadStatusSchema,
  /** The reason of the last rejection, while the request is rejected. */
  rejectReason: z.string().nullable(),
  /** The language of the form (for the call); `null` for a request added by hand. */
  language: catalogLanguageSchema.nullable(),
  /** When consent was given and to which version of its text; `null` for one added by hand. */
  consentAt: z.iso.datetime().nullable(),
  consentVersion: z.string().nullable(),
  /** The supplier created from this request. */
  supplierId: z.uuid().nullable(),
  /** Other requests with this БИН (repeated requests are linked, not merged). */
  sameBinLeads: z.number().int(),
  /** A supplier that already has this БИН. */
  existingSupplierId: z.uuid().nullable(),
  version: z.number().int(),
  statusChangedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AdminSupplierLead = z.infer<typeof adminSupplierLeadSchema>;

export const supplierLeadNoteSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  authorAdminId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type SupplierLeadNote = z.infer<typeof supplierLeadNoteSchema>;

/** Another request with the same БИН, as the card of a request lists it. */
export const relatedSupplierLeadSchema = z.object({
  id: z.uuid(),
  companyName: z.string(),
  status: supplierLeadStatusSchema,
  source: supplierLeadSourceSchema,
  createdAt: z.iso.datetime(),
});

export type RelatedSupplierLead = z.infer<typeof relatedSupplierLeadSchema>;

/**
 * The card of a request (A-SUP-01): its data, notes (newest first) and
 * the other requests with its БИН (newest first). The history of its
 * statuses is the action journal: `GET /admin/audit-log?entityType=supplier_lead&entityId=<id>`.
 */
export const adminSupplierLeadCardSchema = z.object({
  lead: adminSupplierLeadSchema,
  notes: z.array(supplierLeadNoteSchema),
  related: z.array(relatedSupplierLeadSchema),
});

export type AdminSupplierLeadCard = z.infer<typeof adminSupplierLeadCardSchema>;

export const supplierLeadIdPathSchema = z.object({ leadId: z.uuid() });

export type SupplierLeadIdPath = z.infer<typeof supplierLeadIdPathSchema>;

/**
 * Newest first. `bin` — exactly this БИН (spaces and dashes ignored);
 * `q` — a part of the company name; `from`/`to` — when the request came.
 */
export const supplierLeadListQuerySchema = z.object({
  status: supplierLeadStatusSchema.optional(),
  cityId: z.uuid().optional(),
  type: supplierTypeSchema.optional(),
  source: supplierLeadSourceSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  bin: z.string().trim().min(1).max(32).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type SupplierLeadListQuery = z.infer<typeof supplierLeadListQuerySchema>;

export const adminSupplierLeadPageSchema = z.object({
  leads: z.array(adminSupplierLeadSchema),
  /** How many requests match the filters, on every page. */
  total: z.number().int(),
  /** Requests per status under the other filters (the columns of the funnel). */
  counts: z.record(supplierLeadStatusSchema, z.number().int()),
  /** Pass as `cursor` for the next page; `null` — this was the last one. */
  nextCursor: z.string().nullable(),
});

export type AdminSupplierLeadPage = z.infer<typeof adminSupplierLeadPageSchema>;

/** A request added by hand after a call (source `admin`, status `new`). */
export const createSupplierLeadBodySchema = z.object({
  companyName: plainText(SUPPLIER_NAME_MAX_LENGTH),
  bin: binInputSchema,
  cityId: z.uuid(),
  type: supplierTypeSchema,
  contactName: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH),
  phone: phoneInputSchema,
  /** The first note, e.g. what the call was about. */
  note: plainText(SUPPLIER_NOTE_MAX_LENGTH).optional(),
});

export type CreateSupplierLeadBody = z.infer<typeof createSupplierLeadBodySchema>;

/** Corrections of the data of a request not yet onboarded; a field left out stays. */
export const updateSupplierLeadBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  companyName: plainText(SUPPLIER_NAME_MAX_LENGTH).optional(),
  bin: binInputSchema.optional(),
  cityId: z.uuid().optional(),
  type: supplierTypeSchema.optional(),
  contactName: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH).optional(),
  phone: phoneInputSchema.optional(),
});

export type UpdateSupplierLeadBody = z.infer<typeof updateSupplierLeadBodySchema>;

/**
 * A move along the funnel by hand. `reason` is required to reject and to
 * take a rejected request back into work. `onboarded` is refused (409
 * `SUPPLIER_LEAD_STATE`): only creating the supplier sets it.
 */
export const setSupplierLeadStatusBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  status: supplierLeadStatusSchema,
  reason: reasonSchema.optional(),
});

export type SetSupplierLeadStatusBody = z.infer<typeof setSupplierLeadStatusBodySchema>;

export const addSupplierLeadNoteBodySchema = z.object({
  text: plainText(SUPPLIER_NOTE_MAX_LENGTH),
});

export type AddSupplierLeadNoteBody = z.infer<typeof addSupplierLeadNoteBodySchema>;

export const adminSupplierLeadResponseSchema = z.object({ lead: adminSupplierLeadCardSchema });

export type AdminSupplierLeadResponse = z.infer<typeof adminSupplierLeadResponseSchema>;

// ------------------------------------------------------------- the schedule

/** `HH:MM`, 00:00–24:00 (`24:00` only as the end of a day). */
export const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, {
  message: "Must be a time HH:MM between 00:00 and 24:00",
});

export const hoursIntervalSchema = z.object({ from: timeOfDaySchema, to: timeOfDaySchema });

export type HoursInterval = z.infer<typeof hoursIntervalSchema>;

/**
 * One day of the week: ISO number (1 — Monday … 7 — Sunday) and its
 * working intervals in the supplier's time zone. No intervals — a day off;
 * two — a lunch break; `00:00–24:00` — around the clock. An interval never
 * crosses midnight: a night shift is `22:00–24:00` and `00:00–02:00` of
 * the next day.
 */
export const dayHoursSchema = z.object({
  day: z.number().int().min(1).max(7),
  intervals: z.array(hoursIntervalSchema).max(SUPPLIER_DAY_INTERVALS_MAX),
});

export type DayHours = z.infer<typeof dayHoursSchema>;

function minutesOf(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Exactly seven days, Monday to Sunday; the intervals of a day in order, not overlapping. */
export const weeklyHoursSchema = z.array(dayHoursSchema).superRefine((days, context) => {
  if (days.length !== 7 || days.some((day, index) => day.day !== index + 1)) {
    context.addIssue({
      code: "custom",
      message: "Must list the seven days in order, 1 (Monday) to 7 (Sunday)",
    });
    return;
  }
  for (const [dayIndex, day] of days.entries()) {
    let previousEnd = -1;
    for (const [index, interval] of day.intervals.entries()) {
      const from = minutesOf(interval.from);
      const to = minutesOf(interval.to);
      if (from >= to) {
        context.addIssue({
          code: "custom",
          path: [dayIndex, "intervals", index],
          message: "The end must be after the start (an interval never crosses midnight)",
        });
      } else if (from < previousEnd) {
        context.addIssue({
          code: "custom",
          path: [dayIndex, "intervals", index],
          message: "Intervals must be in order and must not overlap",
        });
      }
      previousEnd = to;
    }
  }
});

export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

/** A date the point doesn't work (a holiday, a vacation) in the supplier's time zone. */
export const closedDateSchema = z.object({
  date: dateSchema,
  note: plainText(SUPPLIER_CLOSED_DATE_NOTE_MAX_LENGTH).nullable(),
});

export type ClosedDate = z.infer<typeof closedDateSchema>;

/**
 * The hours of the pickup point (`null` — not given yet) and its days off
 * from today on (earlier ones are kept as history and not shown).
 */
export const supplierScheduleSchema = z.object({
  weeklyHours: weeklyHoursSchema.nullable(),
  closedDates: z.array(closedDateSchema),
});

export type SupplierSchedule = z.infer<typeof supplierScheduleSchema>;

/**
 * `PUT …/schedule` — the whole schedule at once. `closedDates` replaces
 * the days off from today on: each date once, none before today in the
 * supplier's time zone (a past date is refused on `closedDates.<i>.date`),
 * none more than two years ahead.
 */
export const setSupplierScheduleBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  weeklyHours: weeklyHoursSchema,
  closedDates: z.array(closedDateSchema).max(SUPPLIER_CLOSED_DATES_MAX),
});

export type SetSupplierScheduleBody = z.infer<typeof setSupplierScheduleBodySchema>;

// ---------------------------------------------------------------- suppliers

/** `active` — neither paused nor blocked; `blocked` wins over `paused`. */
export const supplierStateSchema = z.enum(["active", "paused", "blocked"]);

export type SupplierStateValue = z.infer<typeof supplierStateSchema>;

/** `billing` — the subscription isn't paid (lifted by billing, EPIC-14, or by hand); `admin` — an administrator's decision. */
export const supplierPauseReasonSchema = z.enum(["billing", "admin"]);

export type SupplierPauseReasonValue = z.infer<typeof supplierPauseReasonSchema>;

/** The one pickup point of the supplier in the MVP (several — BACKLOG). */
export const supplierLocationSchema = z.object({
  id: z.uuid(),
  city: cityRefSchema,
  /** Street and building; shown to a subscriber with an accepted order (D-026). */
  address: z.string().nullable(),
  /** Shown to a subscriber before ordering (D-030). */
  district: z.string().nullable(),
});

export type SupplierLocation = z.infer<typeof supplierLocationSchema>;

/**
 * A supplier's card (A-SUP-03 «Профиль» and «Статусы»); the cabinet sees
 * the same (`GET /supplier/company`).
 */
export const supplierCardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `null` only for a company created before TASK-016 without one. */
  bin: z.string().nullable(),
  type: supplierTypeSchema,
  city: cityRefSchema,
  /** From the city, may be changed. */
  timeZone: z.string(),
  contactName: z.string().nullable(),
  /** The company's phone (`+77XXXXXXXXX`), shown to a subscriber with an accepted order (D-026). */
  contactPhone: z.string().nullable(),
  location: supplierLocationSchema,
  schedule: supplierScheduleSchema,
  state: supplierStateSchema,
  /**
   * Whether the supplier's offers may be on the showcase (EPIC-07 reads
   * this): only when neither paused nor blocked. Neither closes the
   * cabinet (SCREENS 6.0) nor touches current orders.
   */
  visibleOnShowcase: z.boolean(),
  /** A verified partner (PRODUCT 13): set by an administrator after the contract. */
  verification: z.object({ contractSignedOn: dateSchema, verifiedAt: z.iso.datetime() }).nullable(),
  pause: z
    .object({
      reason: supplierPauseReasonSchema,
      note: z.string().nullable(),
      since: z.iso.datetime(),
    })
    .nullable(),
  block: z.object({ reason: z.string(), since: z.iso.datetime() }).nullable(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type SupplierCard = z.infer<typeof supplierCardSchema>;

export const supplierInvitationStatusSchema = z.enum(["queued", "sent", "failed"]);

export type SupplierInvitationStatus = z.infer<typeof supplierInvitationStatusSchema>;

export const supplierInvitationSchema = z.object({
  id: z.uuid(),
  memberId: z.uuid(),
  status: supplierInvitationStatusSchema,
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
});

export type SupplierInvitation = z.infer<typeof supplierInvitationSchema>;

/** An employee as the card of the supplier lists them (the full management is TASK-017). */
export const adminSupplierMemberSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  phone: z.string(),
  status: z.enum(["active", "removed"]),
  /** The latest invitation sent to this employee. */
  lastInvitation: supplierInvitationSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export type AdminSupplierMember = z.infer<typeof adminSupplierMemberSchema>;

export const adminSupplierCardSchema = supplierCardSchema.extend({
  /** The request the supplier was created from. */
  leadId: z.uuid().nullable(),
  members: z.array(adminSupplierMemberSchema),
});

export type AdminSupplierCard = z.infer<typeof adminSupplierCardSchema>;

export const adminSupplierResponseSchema = z.object({ supplier: adminSupplierCardSchema });

export type AdminSupplierResponse = z.infer<typeof adminSupplierResponseSchema>;

export const adminSupplierListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  bin: z.string().nullable(),
  type: supplierTypeSchema,
  city: cityRefSchema,
  state: supplierStateSchema,
  verified: z.boolean(),
  visibleOnShowcase: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type AdminSupplierListItem = z.infer<typeof adminSupplierListItemSchema>;

/**
 * `state`: `active`, `paused`, `blocked` — the state; `verified` —
 * verified partners in any state. `q` — a part of the name or of the БИН.
 * By name.
 */
export const supplierListQuerySchema = z.object({
  state: z.enum(["active", "paused", "blocked", "verified"]).optional(),
  cityId: z.uuid().optional(),
  type: supplierTypeSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: pageLimitSchema,
  cursor: cursorSchema.optional(),
});

export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

export const adminSupplierPageSchema = z.object({
  suppliers: z.array(adminSupplierListItemSchema),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminSupplierPage = z.infer<typeof adminSupplierPageSchema>;

export const supplierAdminPathSchema = z.object({ supplierId: z.uuid() });

export type SupplierAdminPath = z.infer<typeof supplierAdminPathSchema>;

export const supplierMemberPathSchema = z.object({ supplierId: z.uuid(), memberId: z.uuid() });

export type SupplierMemberPath = z.infer<typeof supplierMemberPathSchema>;

const firstMemberSchema = z.object({
  name: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH),
  /** A Kazakhstan mobile number; its account is created if there is none. */
  phone: phoneInputSchema,
});

/**
 * `POST /admin/suppliers` — a supplier without a request (A-SUP-04 by
 * hand): the company, its pickup point and its first employee, who gets
 * an invitation. One БИН — one supplier (409 `SUPPLIER_BIN_TAKEN`).
 */
export const createSupplierBodySchema = z.object({
  name: plainText(SUPPLIER_NAME_MAX_LENGTH),
  bin: binInputSchema,
  cityId: z.uuid(),
  type: supplierTypeSchema,
  contactName: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH).optional(),
  contactPhone: phoneInputSchema.optional(),
  address: plainText(SUPPLIER_ADDRESS_MAX_LENGTH).optional(),
  district: plainText(SUPPLIER_DISTRICT_MAX_LENGTH).optional(),
  firstMember: firstMemberSchema,
});

export type CreateSupplierBody = z.infer<typeof createSupplierBodySchema>;

/**
 * `POST /admin/supplier-leads/{leadId}/onboard` — a supplier from a request
 * with a signed contract (A-SUP-04 from the funnel). What is left out comes
 * from the request: the company name, БИН, city, type; the contact and
 * the first employee — its contact person and phone.
 */
export const onboardSupplierLeadBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  name: plainText(SUPPLIER_NAME_MAX_LENGTH).optional(),
  bin: binInputSchema.optional(),
  cityId: z.uuid().optional(),
  type: supplierTypeSchema.optional(),
  contactName: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH).optional(),
  contactPhone: phoneInputSchema.optional(),
  address: plainText(SUPPLIER_ADDRESS_MAX_LENGTH).optional(),
  district: plainText(SUPPLIER_DISTRICT_MAX_LENGTH).optional(),
  firstMember: z
    .object({
      name: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH).optional(),
      phone: phoneInputSchema.optional(),
    })
    .optional(),
});

export type OnboardSupplierLeadBody = z.infer<typeof onboardSupplierLeadBodySchema>;

/** What creating a supplier did. */
export const supplierOnboardedResponseSchema = z.object({
  supplier: adminSupplierCardSchema,
  /** The request, now `onboarded`; `null` for a supplier created without one. */
  lead: adminSupplierLeadSchema.nullable(),
  firstMember: z.object({
    memberId: z.uuid(),
    accountId: z.uuid(),
    /** The number had no account before. */
    accountCreated: z.boolean(),
    /** The number already works for another company (it keeps that access). */
    memberOfOtherSuppliers: z.number().int(),
    /** The number is also an administrator (the two sessions never mix). */
    isAdministrator: z.boolean(),
  }),
  invitation: supplierInvitationSchema,
});

export type SupplierOnboardedResponse = z.infer<typeof supplierOnboardedResponseSchema>;

/**
 * The profile, by an administrator; a field left out stays, `null` clears
 * an optional one. The city moves the pickup point with it; the time zone
 * is then the new city's unless given.
 */
export const updateSupplierBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  name: plainText(SUPPLIER_NAME_MAX_LENGTH).optional(),
  bin: binInputSchema.optional(),
  cityId: z.uuid().optional(),
  type: supplierTypeSchema.optional(),
  contactName: plainText(SUPPLIER_CONTACT_NAME_MAX_LENGTH).nullable().optional(),
  contactPhone: phoneInputSchema.nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  address: plainText(SUPPLIER_ADDRESS_MAX_LENGTH).nullable().optional(),
  district: plainText(SUPPLIER_DISTRICT_MAX_LENGTH).nullable().optional(),
});

export type UpdateSupplierBody = z.infer<typeof updateSupplierBodySchema>;

/**
 * Verified partner: `verified: true` with the date the contract was signed
 * (not in the future; a new date replaces the old one); `verified: false`
 * with the reason.
 */
export const setSupplierVerificationBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  verified: z.boolean(),
  contractSignedOn: dateSchema.optional(),
  reason: reasonSchema.optional(),
});

export type SetSupplierVerificationBody = z.infer<typeof setSupplierVerificationBodySchema>;

/**
 * Pause: `paused: true` with its reason (`billing`/`admin`; pausing a
 * paused supplier changes the reason); `paused: false` lifts it. `note` —
 * why, always.
 */
export const setSupplierPauseBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  paused: z.boolean(),
  reason: supplierPauseReasonSchema.optional(),
  note: reasonSchema,
});

export type SetSupplierPauseBody = z.infer<typeof setSupplierPauseBodySchema>;

/** Blocking and lifting it, always with the reason. */
export const setSupplierBlockBodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  blocked: z.boolean(),
  reason: reasonSchema,
});

export type SetSupplierBlockBody = z.infer<typeof setSupplierBlockBodySchema>;

export const supplierInvitationResponseSchema = z.object({ invitation: supplierInvitationSchema });

export type SupplierInvitationResponse = z.infer<typeof supplierInvitationResponseSchema>;

/** `PUT /supplier/company/schedule`: the cabinet's own card after the change. */
export const supplierCardResponseSchema = z.object({ company: supplierCardSchema });

export type SupplierCardResponse = z.infer<typeof supplierCardResponseSchema>;

// ------------------------------------------------------------------- errors

/** `details` of `CITY_VERSION_CONFLICT` and `SUPPLIER_VERSION_CONFLICT` (409): reload and decide again. */
export const supplierVersionConflictDetailsSchema = z.object({
  currentVersion: z.number().int(),
});

export type SupplierVersionConflictDetails = z.infer<typeof supplierVersionConflictDetailsSchema>;

/** `details` of `CITY_DUPLICATE` (409): the city that already has this code or name. */
export const cityDuplicateDetailsSchema = z.object({
  existingId: z.uuid(),
  field: z.enum(["code", "name"]),
  value: z.string(),
});

export type CityDuplicateDetails = z.infer<typeof cityDuplicateDetailsSchema>;

/** `details` of `SUPPLIER_BIN_TAKEN` (409): the supplier that already has this БИН. */
export const supplierBinTakenDetailsSchema = z.object({ existingSupplierId: z.uuid() });

export type SupplierBinTakenDetails = z.infer<typeof supplierBinTakenDetailsSchema>;

/**
 * `details` of `SUPPLIER_LEAD_STATE` (409): the request can't do this in
 * its status. `refusal`: `same` — it already has the status;
 * `onboarded_only_by_onboarding` — only creating the supplier sets
 * `onboarded`; `final` — an onboarded request never changes;
 * `contract_not_signed` — a supplier is created only from a request with
 * a signed contract.
 */
export const supplierLeadStateDetailsSchema = z.object({
  status: supplierLeadStatusSchema,
  refusal: z.enum(["same", "onboarded_only_by_onboarding", "final", "contract_not_signed"]),
});

export type SupplierLeadStateDetails = z.infer<typeof supplierLeadStateDetailsSchema>;

/**
 * `details` of `SUPPLIER_STATE` (409): the state already is what was asked
 * for lifting (`not_paused`, `not_blocked`, `not_verified`) or setting
 * (`already_blocked`).
 */
export const supplierStateDetailsSchema = z.object({
  refusal: z.enum(["not_paused", "not_blocked", "not_verified", "already_blocked"]),
});

export type SupplierStateDetails = z.infer<typeof supplierStateDetailsSchema>;
