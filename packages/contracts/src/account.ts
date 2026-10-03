import { z } from "zod";
import { catalogLanguageSchema } from "./catalog";

/**
 * The member's profile on the account (PRODUCT 6.1; SCREENS M-AUTH-03,
 * M-PRO-02; TASK-029, ARCHITECTURE 4.41): a name (required to act as a club
 * member — the supplier reads it once an order is accepted), the city and
 * interface language once they live in the account rather than only on a
 * device, an optional e-mail with its own newsletter consent, and the
 * consent to share the phone number with a supplier (already part of the
 * account since TASK-004: `consentPhoneShareAt`, `consentVersion`).
 *
 * The phone number itself is never part of a body here — it cannot be
 * changed in MVP (PRODUCT 6.1), and a route that took it would have to
 * decide what an attempt to change it means; there is no such route.
 */

export const ACCOUNT_NAME_MAX_LENGTH = 80;

/**
 * A letter of any script (so the Kazakh letters ә ғ қ ң ө ұ ү h і pass, as
 * SCREENS M-AUTH-03 calls for explicitly), then letters, single spaces,
 * hyphens and apostrophes — no digits, no emoji, no control characters.
 * The schema trims the edges; the server then collapses inner whitespace
 * (`AccountProfileService`), so " Марат  Б " and "Марат Б" are stored alike.
 * The length limit is counted before that collapse.
 */
export const accountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACCOUNT_NAME_MAX_LENGTH)
  .regex(/^[\p{L}][\p{L}\s'’-]*$/u, "Only letters, spaces, hyphens and an apostrophe");

export type AccountName = z.infer<typeof accountNameSchema>;

/** The consent to share the phone number with a supplier once it accepts an order. */
export const phoneShareConsentSchema = z.object({
  /** The text version shown when it was given (working text until TASK-072). */
  version: z.string().min(1).max(50),
  at: z.iso.datetime(),
});

export type PhoneShareConsent = z.infer<typeof phoneShareConsentSchema>;

/** `GET /account/profile`, and the body of `PATCH`/`POST /auth/complete-registration` echoed back. */
export const accountProfileSchema = z.object({
  /** `null` — registration is not finished (`registrationCompleted` says so too). */
  name: z.string().nullable(),
  /** E.164; read-only everywhere (PRODUCT 6.1). */
  phone: z.string(),
  email: z.string().nullable(),
  /** "Получать новости клуба на e-mail" (SCREENS M-PRO-02); meaningless without `email`. */
  emailNewsConsent: z.boolean(),
  /** `null` — "весь Казахстан". */
  cityId: z.uuid().nullable(),
  /** `null` — not yet transferred from a device (TASK-029 requirement 5). */
  language: catalogLanguageSchema.nullable(),
  /** A name and the phone-share consent are both there — whether this account may act as a club member. */
  registrationCompleted: z.boolean(),
  phoneShareConsent: phoneShareConsentSchema.nullable(),
});

export type AccountProfile = z.infer<typeof accountProfileSchema>;

/**
 * `POST /auth/complete-registration` (SCREENS M-AUTH-03 «Готово»): the
 * account already exists (created when the login code was verified,
 * ARCHITECTURE 4.6 I45) — this only gives it a name and records the consent
 * that unlocks acting as a club member. Calling it again (a retried
 * request, a name changed later through `PATCH /account/profile` instead)
 * is not an error: it simply sets the fields again.
 */
export const completeRegistrationBodySchema = z.object({
  name: accountNameSchema,
  /** The mandatory checkbox of M-AUTH-03 (T-AUTH-05) must have been checked. */
  phoneShareConsent: z.literal(true),
  /** The text version of the consent shown (working text until TASK-072). */
  phoneShareConsentVersion: z.string().min(1).max(50),
});

export type CompleteRegistrationBody = z.infer<typeof completeRegistrationBodySchema>;

/**
 * `PATCH /account/profile` (SCREENS M-PRO-02 «Мои данные», and the silent
 * transfer of the device's city and language after registration, TASK-029
 * requirement 5): every field optional, `phone` not among them. The body
 * stays open to fields it doesn't declare (a newer client, ARCHITECTURE 7.4:
 * a `.strict()` schema would also fail `openapi.test.ts`), except `phone`
 * itself, which is refused by name (400 `VALIDATION_ERROR` on `phone`) —
 * the number doesn't change in MVP (PRODUCT 6.1), the same way
 * `PATCH /supplier/company` refuses the administrator's fields. `email: null`
 * clears the address, and the server turns `emailNewsConsent` off with it,
 * since a consent about an address that no longer exists cannot stay on.
 */
export const updateAccountProfileBodySchema = z
  .object({
    name: accountNameSchema.optional(),
    email: z.string().trim().toLowerCase().max(254).email().nullable().optional(),
    emailNewsConsent: z.boolean().optional(),
    cityId: z.uuid().nullable().optional(),
    language: catalogLanguageSchema.optional(),
  })
  .loose()
  .superRefine((body, context) => {
    // The one field refused by name (PRODUCT 6.1: the phone number does not
    // change in MVP): a body naming it is a mistake worth a clear answer,
    // not one to swallow. Every other unknown field stays tolerated.
    if ("phone" in body) {
      context.addIssue({
        code: "custom",
        path: ["phone"],
        message: "The phone number cannot be changed",
      });
    }
  });

export type UpdateAccountProfileBody = z.infer<typeof updateAccountProfileBodySchema>;
