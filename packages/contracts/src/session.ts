import { z } from "zod";
import { sessionAccessSchema, supplierSummarySchema } from "./access";
import { clientPlatformSchema } from "./client";

/**
 * Kinds of sessions (ARCHITECTURE 8.2): each has its own lifetime and way
 * of keeping the refresh token. New kinds are only ever added.
 * - `mobile`: the user app; tokens travel in response bodies.
 * - `supplier_web`: the supplier cabinet; the refresh token lives in an
 *   HttpOnly cookie.
 * - `admin_web`: the admin panel; refresh token in an HttpOnly cookie.
 */
export const sessionKindSchema = z.enum(["mobile", "supplier_web", "admin_web"]);

export type SessionKind = z.infer<typeof sessionKindSchema>;

/**
 * A new or refreshed session. Send `accessToken` as
 * `Authorization: Bearer <accessToken>`; once it expires
 * (`ACCESS_TOKEN_EXPIRED`), exchange the refresh token for a new pair.
 * The refresh token works exactly once, except that repeating the same
 * exchange shortly after returns the same pair (a retry or two
 * concurrent exchanges by one client); presenting an older one ends the
 * session.
 */
export const sessionTokensSchema = z.object({
  sessionId: z.uuid(),
  kind: sessionKindSchema,
  accessToken: z.string(),
  /** The access token stops being accepted at this moment (ISO 8601). */
  accessTokenExpiresAt: z.iso.datetime(),
  /**
   * Only for `mobile` sessions — keep it in the device's secure storage.
   * Web sessions get it in an HttpOnly cookie instead, never in the body.
   */
  refreshToken: z.string().optional(),
  /**
   * The session ends at this moment unless it is refreshed before
   * (sliding sessions move it forward on every refresh; the admin
   * session never moves past 12 hours from sign-in).
   */
  sessionExpiresAt: z.iso.datetime(),
});

export type SessionTokens = z.infer<typeof sessionTokensSchema>;

/**
 * `POST /auth/session/refresh`. A mobile client sends its refresh token in
 * the body; a web client sends `{}` with credentials, and the token is
 * read from its HttpOnly cookie (the request must come from the web
 * client's own origin).
 */
export const refreshSessionBodySchema = z.object({
  refreshToken: z.string().min(1).max(256).optional(),
});

export type RefreshSessionBody = z.infer<typeof refreshSessionBodySchema>;

/** One of the account's active sessions ("devices"). */
export const sessionSummarySchema = z.object({
  id: z.uuid(),
  kind: sessionKindSchema,
  /** The session making this request. */
  current: z.boolean(),
  /** Device or browser name the client sent at sign-in, if any. */
  deviceName: z.string().nullable(),
  /** From `X-Client` at sign-in; `null` when the client didn't identify itself. */
  platform: clientPlatformSchema.nullable(),
  clientVersion: z.string().nullable(),
  /**
   * Shortened network address of the last use (`203.0.113.*`,
   * `2001:db8:1::*`); the full address is never shown.
   */
  ipHint: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Supplier cabinet sessions: the company the session works for; otherwise `null`. */
  supplier: supplierSummarySchema.nullable(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** `GET /auth/sessions`: active sessions, most recently used first. */
export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

/** `GET /auth/me`: who is signed in, and with which session. */
export const currentAccountResponseSchema = z.object({
  account: z.object({
    id: z.uuid(),
    /** E.164. */
    phone: z.string(),
    createdAt: z.iso.datetime(),
  }),
  session: sessionSummarySchema,
  /** What this session may act as — only its own context, never the account's other roles. */
  access: sessionAccessSchema,
});

export type CurrentAccountResponse = z.infer<typeof currentAccountResponseSchema>;

/** Result of logging out or ending sessions. */
export const sessionsEndedResponseSchema = z.object({
  /** How many sessions this request ended. */
  ended: z.number().int(),
  /** Whether the session making the request was among them. */
  currentEnded: z.boolean(),
});

export type SessionsEndedResponse = z.infer<typeof sessionsEndedResponseSchema>;

/** Path parameters of `DELETE /auth/sessions/{sessionId}`. */
export const sessionIdPathSchema = z.object({
  sessionId: z.uuid(),
});

export type SessionIdPath = z.infer<typeof sessionIdPathSchema>;
