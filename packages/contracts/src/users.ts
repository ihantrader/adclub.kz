import { z } from "zod";
import { hiddenPhoneSchema, phoneShareConsentSchema } from "./account";
import { catalogLanguageSchema } from "./catalog";
import { clubAccessStateSchema } from "./club-access";
import { accountCarSchema } from "./garage";
import { orderStatusSchema } from "./orders";

/**
 * The users of the app in the admin panel (TASK-036.B; SCREENS A-USR-01,
 * A-USR-02), the administrator's one search of the whole club (A-SEARCH)
 * and the one way a person's full phone number reaches the admin panel
 * («Показать номер», SCREENS 7.0).
 *
 * **Every admin answer carries a person's number partly hidden** —
 * «+7 701 *** ** 67»; the full number comes only from
 * `POST /admin/phone-reveals`, and every such answer is written to the
 * action journal (who, whose, about which object — never the number).
 */

export const USER_PAGE_MAX_SIZE = 100;
export const USER_PAGE_DEFAULT_SIZE = 50;
/** «Истекает в ближайшие N дней» of A-USR-01, when N is left out. */
export const USER_ACCESS_EXPIRING_DAYS_DEFAULT = 7;
export const ADMIN_SEARCH_QUERY_MAX_LENGTH = 100;
/** How many of each kind the search shows. */
export const ADMIN_SEARCH_GROUP_LIMIT = 8;

// ------------------------------------------------------------------ users

/**
 * A-USR-01: `q` — the phone number, whole or in part, in any spelling
 * (`8 701`, `+7 (701) 12`, the last digits), or a part of the name; club
 * access now (`active`), none (`none`) or ending within `expiringDays`
 * (`expiring`); `noShows=true` — with a no-show mark that still stands;
 * `unconfirmedCar=true` — with a car whose registration certificate was not
 * shown (marked «документ не подтверждён», or added before TASK-057 without
 * any mark; D-064).
 * Newest accounts first. A user is an account of the app: it finished the
 * registration, signed in to the app, ordered, keeps cars or was given club
 * access — an account that only works in a cabinet or the admin panel is
 * not one.
 */
export const adminUserListQuerySchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  clubAccess: z.enum(["active", "none", "expiring"]).optional(),
  expiringDays: z.coerce.number().int().min(1).max(366).default(USER_ACCESS_EXPIRING_DAYS_DEFAULT),
  noShows: z.enum(["true"]).optional(),
  unconfirmedCar: z.enum(["true"]).optional(),
  limit: z.coerce.number().int().min(1).max(USER_PAGE_MAX_SIZE).default(USER_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminUserSummarySchema = z.object({
  accountId: z.uuid(),
  /** `null` — the registration is not finished: the list shows the number alone. */
  name: z.string().nullable(),
  phone: hiddenPhoneSchema,
  cityName: z.string().nullable(),
  /** When the account appeared (its first sign-in, or a grant by number). */
  createdAt: z.iso.datetime(),
  registrationCompleted: z.boolean(),
  /** Until the stores' subscriptions (TASK-040) — club access in place of «статус подписки». */
  clubAccess: clubAccessStateSchema,
  /** No-show marks that still stand. */
  noShows: z.number().int(),
  /** The account also works for a supplier (an active employee). */
  supplierMember: z.boolean(),
});

export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUserPageSchema = z.object({
  users: z.array(adminUserSummarySchema),
  /** Users matching the filters. */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

export type AdminUserPage = z.infer<typeof adminUserPageSchema>;

export const adminUserPathSchema = z.object({ accountId: z.uuid() });

export type AdminUserPath = z.infer<typeof adminUserPathSchema>;

/** An employment of the account at a supplier: «Сотрудник поставщика: {компания}». */
export const adminUserMembershipSchema = z.object({
  supplierId: z.uuid(),
  supplierName: z.string(),
  memberId: z.uuid(),
  displayName: z.string(),
  status: z.enum(["active", "removed"]),
});

export type AdminUserMembership = z.infer<typeof adminUserMembershipSchema>;

/**
 * A-USR-02: the profile and its consents with their dates, club access
 * now, the account's employments at suppliers and what the card's blocks
 * count. The grants, the garage, the orders, the marks, the sessions and
 * the history are read by their own routes.
 */
export const adminUserSchema = z.object({
  accountId: z.uuid(),
  name: z.string().nullable(),
  phone: hiddenPhoneSchema,
  email: z.string().nullable(),
  emailNewsConsent: z.boolean(),
  city: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  language: catalogLanguageSchema.nullable(),
  createdAt: z.iso.datetime(),
  registrationCompleted: z.boolean(),
  phoneShareConsent: phoneShareConsentSchema.nullable(),
  clubAccess: clubAccessStateSchema,
  memberships: z.array(adminUserMembershipSchema),
  counts: z.object({
    orders: z.number().int(),
    activeOrders: z.number().int(),
    /** No-show marks that stand, and those lifted (kept, never deleted). */
    noShows: z.number().int(),
    noShowsRevoked: z.number().int(),
    cars: z.number().int(),
    /** Active sessions of the app. */
    sessions: z.number().int(),
  }),
});

export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserResponseSchema = z.object({ user: adminUserSchema });

export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

/** The garage of a user, to look at only (A-USR-02); most recently added first. */
export const adminUserGarageResponseSchema = z.object({ cars: z.array(accountCarSchema) });

export type AdminUserGarageResponse = z.infer<typeof adminUserGarageResponseSchema>;

/** An active session of the app of a user: the device and the times, never a token. */
export const adminUserSessionSchema = z.object({
  id: z.uuid(),
  deviceName: z.string().nullable(),
  /** From `X-Client` at sign-in, `null` when unknown. */
  platform: z.string().nullable(),
  clientVersion: z.string().nullable(),
  /** Shortened network address of the last use (`203.0.113.*`). */
  ipHint: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type AdminUserSession = z.infer<typeof adminUserSessionSchema>;

/** Most recently used first. */
export const adminUserSessionListResponseSchema = z.object({
  sessions: z.array(adminUserSessionSchema),
});

export type AdminUserSessionListResponse = z.infer<typeof adminUserSessionListResponseSchema>;

export const adminUserSessionPathSchema = z.object({ accountId: z.uuid(), sessionId: z.uuid() });

export type AdminUserSessionPath = z.infer<typeof adminUserSessionPathSchema>;

export const adminUserSessionsEndedResponseSchema = z.object({ ended: z.number().int() });

export type AdminUserSessionsEndedResponse = z.infer<typeof adminUserSessionsEndedResponseSchema>;

// ------------------------------------------------------------ phone reveal

/**
 * Whose number: a user's account, an employee of a supplier, the contact of
 * a connection request, the customer of an order.
 */
export const phoneRevealSubjectSchema = z.enum([
  "account",
  "supplier_member",
  "supplier_lead",
  "order",
]);

export type PhoneRevealSubject = z.infer<typeof phoneRevealSubjectSchema>;

/**
 * `POST /admin/phone-reveals` («Показать номер», SCREENS 7.0): the full
 * number of one person, by the object the administrator is looking at. A
 * `POST` — it is an action with a trace, and its answer is never cached.
 */
export const revealPhoneBodySchema = z.object({
  subject: phoneRevealSubjectSchema,
  id: z.uuid(),
});

export type RevealPhoneBody = z.infer<typeof revealPhoneBodySchema>;

/** The number in full, `+77XXXXXXXXX`. */
export const revealPhoneResponseSchema = z.object({ phone: z.string() });

export type RevealPhoneResponse = z.infer<typeof revealPhoneResponseSchema>;

// ------------------------------------------------------------------ search

/** `GET /admin/search?q=` (A-SEARCH): one line of the header. */
export const adminSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(ADMIN_SEARCH_QUERY_MAX_LENGTH),
});

export type AdminSearchQuery = z.infer<typeof adminSearchQuerySchema>;

/**
 * How the server read the line: digits of a phone number, the number of an
 * order, a БИН, an article written the catalog's way, a text — several at
 * once («1028» is both a number of an order and a part of a phone).
 */
export const adminSearchReadingSchema = z.object({
  phoneDigits: z.string().nullable(),
  orderNumber: z.number().int().nullable(),
  bin: z.string().nullable(),
  article: z.string().nullable(),
  text: z.string().nullable(),
});

export type AdminSearchReading = z.infer<typeof adminSearchReadingSchema>;

export const adminSearchResponseSchema = z.object({
  reading: adminSearchReadingSchema,
  orders: z.array(
    z.object({
      id: z.uuid(),
      number: z.number().int(),
      status: orderStatusSchema,
      supplierName: z.string(),
      total: z.number().int(),
      createdAt: z.iso.datetime(),
    }),
  ),
  users: z.array(
    z.object({ accountId: z.uuid(), name: z.string().nullable(), phone: hiddenPhoneSchema }),
  ),
  members: z.array(
    z.object({
      memberId: z.uuid(),
      supplierId: z.uuid(),
      supplierName: z.string(),
      displayName: z.string(),
      phone: hiddenPhoneSchema,
      status: z.enum(["active", "removed"]),
    }),
  ),
  suppliers: z.array(
    z.object({ id: z.uuid(), name: z.string(), bin: z.string().nullable(), cityName: z.string() }),
  ),
  leads: z.array(
    z.object({ id: z.uuid(), companyName: z.string(), bin: z.string(), status: z.string() }),
  ),
  items: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      brand: z.string().nullable(),
      article: z.string().nullable(),
    }),
  ),
});

export type AdminSearchResponse = z.infer<typeof adminSearchResponseSchema>;
