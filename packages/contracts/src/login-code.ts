import { z } from "zod";
import { sessionAccessSchema } from "./access";
import { sessionTokensSchema } from "./session";

/**
 * Channels a login code travels through (ARCHITECTURE 8.1): WhatsApp is
 * the primary one, SMS the fallback. New channels are only ever added.
 */
export const loginCodeChannelSchema = z.enum(["whatsapp", "sms"]);

export type LoginCodeChannel = z.infer<typeof loginCodeChannelSchema>;

/**
 * Only the characters people use to write a phone number; the server
 * then accepts Kazakhstan mobile numbers only (`+7 7xx…`, any of the
 * usual spellings) and answers anything else with `VALIDATION_ERROR`.
 */
const phoneInputSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[+\d\s().-]+$/, "Must contain only digits, spaces, +, -, ., ( and )")
  .meta({ examples: ["+7 701 123 45 67", "8 701 1234567"] });

/**
 * `POST /auth/login-code` — send a one-time login code to a phone number.
 * `channel` is the user's explicit choice: `sms` sends by SMS right away
 * (also the "didn't get it" resend); omitted or `whatsapp` tries WhatsApp
 * first and falls back to SMS if delivery fails.
 */
export const requestLoginCodeBodySchema = z.object({
  phone: phoneInputSchema,
  channel: loginCodeChannelSchema.optional(),
});

export type RequestLoginCodeBody = z.infer<typeof requestLoginCodeBodySchema>;

/**
 * The same for every number, whether or not an account exists for it.
 */
export const loginCodeSentResponseSchema = z.object({
  /** The number the code was sent to, in E.164 (`+77011234567`). */
  phone: z.string(),
  /** Where the code actually went — `sms` if WhatsApp delivery failed. */
  channel: loginCodeChannelSchema,
  codeLength: z.number().int(),
  /** The code stops being accepted at this moment (ISO 8601). */
  expiresAt: z.iso.datetime(),
  /** No new code (by any channel) can be requested before this moment. */
  resendAvailableAt: z.iso.datetime(),
});

export type LoginCodeSentResponse = z.infer<typeof loginCodeSentResponseSchema>;

/**
 * `POST /auth/login-code/verify` — check the code the user typed in. The
 * session kind follows the calling client (`X-Client`): the mobile app
 * (or a caller that doesn't identify itself) gets a `mobile` session.
 * The supplier cabinet gets a session only for an active employee
 * (several companies: `SUPPLIER_SELECTION_REQUIRED`), the admin panel only
 * for an administrator and only after the second factor
 * (`TOTP_SETUP_REQUIRED` / `TOTP_REQUIRED`); otherwise the code is spent
 * and the answer is `NOT_SUPPLIER_MEMBER` / `NOT_ADMIN`.
 */
export const verifyLoginCodeBodySchema = z.object({
  phone: phoneInputSchema,
  code: z.string().min(1).max(16).regex(/^\d+$/, "Must contain only digits"),
  /** Shown in the list of sessions, e.g. "iPhone 15" or "Chrome on Windows". */
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^\P{Cc}*$/u, "Must not contain control characters")
    .optional(),
  /**
   * Supplier cabinet: the company chosen last time. Used when the number
   * is still an active employee there; otherwise the usual choice applies.
   */
  supplierId: z.uuid().optional(),
});

export type VerifyLoginCodeBody = z.infer<typeof verifyLoginCodeBodySchema>;

/**
 * The phone number is confirmed and the code is spent. The account for
 * the number is created on the first confirmation; the session is
 * created in the same request (TASK-005).
 */
export const loginCodeVerifiedResponseSchema = z.object({
  status: z.literal("verified"),
  phone: z.string(),
  accountId: z.uuid(),
  session: sessionTokensSchema,
  /** What the new session acts as (`user` for the mobile app). */
  access: sessionAccessSchema,
});

export type LoginCodeVerifiedResponse = z.infer<typeof loginCodeVerifiedResponseSchema>;

/** `details` of `LOGIN_CODE_INVALID`. */
export const loginCodeInvalidDetailsSchema = z.object({
  /** `0` means the code is no longer accepted: request a new one. */
  attemptsRemaining: z.number().int(),
});

export type LoginCodeInvalidDetails = z.infer<typeof loginCodeInvalidDetailsSchema>;

/**
 * Which limit was hit (`details.limit` of `RATE_LIMITED`). Clients show
 * the wait time; the value is for logs and support. New values may appear.
 */
export const rateLimitNameSchema = z.enum([
  "login_code_resend_interval",
  "login_code_requests_per_phone",
  "login_code_requests_per_ip",
  "login_code_sms_per_phone_daily",
  "login_code_sms_per_ip_daily",
  "login_code_verifications_per_phone",
  "login_code_verify_delay",
  // Sessions (TASK-005).
  "session_refresh_per_session",
  "session_refresh_per_ip",
  // Admin second factor (TASK-006).
  "admin_totp_per_admin",
  "admin_totp_per_ip",
  // Compatibility proposals of a supplier (TASK-015).
  "compatibility_proposals_per_supplier",
  // Routes open without signing in (TASK-016, ARCHITECTURE 4.26): per client address.
  "supplier_lead_per_ip",
  "compatibility_check_per_ip",
  // The catalog for users (TASK-020.A): a guest per address, a session per account.
  "catalog_read_per_ip",
  "catalog_read_per_account",
  // The connection request form: per phone number.
  "supplier_lead_per_phone",
  // Sending an invitation to an employee again.
  "supplier_invitation_resend",
  // Employees added by the employees of one company (TASK-017).
  "supplier_members_added_per_supplier",
  // The search of catalog items in the cabinet, per employee (TASK-018).
  "offer_item_search_per_member",
]);

export type RateLimitName = z.infer<typeof rateLimitNameSchema>;

/**
 * `details` of `RATE_LIMITED` (HTTP 429, also sent as `Retry-After`):
 * the request may be repeated after `retryAfterSeconds`.
 */
export const rateLimitedDetailsSchema = z.object({
  limit: rateLimitNameSchema,
  retryAfterSeconds: z.number().int(),
});

export type RateLimitedDetails = z.infer<typeof rateLimitedDetailsSchema>;
