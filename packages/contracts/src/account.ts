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
 * A person's phone number in an admin answer (TASK-036.B; SCREENS 7.0):
 * always partly hidden, «+7 701 *** ** 67». The full number comes only
 * from `POST /admin/phone-reveals`, which is written to the journal.
 */
export const hiddenPhoneSchema = z.string().describe('Partly hidden, e.g. "+7 701 *** ** 67"');

/**
 * A letter of any script (so the Kazakh letters ә ғ қ ң ө ұ ү h і pass, as
 * SCREENS M-AUTH-03 calls for explicitly), then letters, single spaces,
 * hyphens and apostrophes — no digits, no emoji, no control characters.
 * A letter typed as a base letter and a combining mark («и» + U+0306 for
 * «й», what some keyboards and pasted text give) passes: the text is
 * brought to NFC first, and a mark left without a precomposed form is
 * allowed after a letter (`\p{M}`, TASK-029.B). Only the plain space
 * separates words — a line break or a tab is not part of a name.
 * The schema trims the edges; the server then collapses inner spaces
 * (`AccountProfileService`), so " Марат  Б " and "Марат Б" are stored alike.
 * The length limit is counted before that collapse.
 */
export const accountNameSchema = z
  .string()
  .trim()
  .normalize("NFC")
  .min(1)
  .max(ACCOUNT_NAME_MAX_LENGTH)
  .regex(/^\p{L}[\p{L}\p{M} '’-]*$/u, "Only letters, spaces, hyphens and an apostrophe");

export type AccountName = z.infer<typeof accountNameSchema>;

/** The consent to share the phone number with a supplier once it accepts an order. */
export const phoneShareConsentSchema = z.object({
  /** The text version shown when it was given (working text until TASK-072). */
  version: z.string().min(1).max(50),
  at: z.iso.datetime(),
});

export type PhoneShareConsent = z.infer<typeof phoneShareConsentSchema>;

/**
 * The kinds of consent an account gives (TASK-072, D-077): the number to a
 * supplier (T-AUTH-05), the terms of use and the privacy policy, keeping the
 * VIN and the plate number (D-064, T-GAR-02).
 */
export const consentKindSchema = z.enum(["phone_share", "terms", "vehicle_document"]);

export type ConsentKindValue = z.infer<typeof consentKindSchema>;

/** One consent of the account's journal (M-PRO-06 «Мои согласия», A-USR-02). */
export const accountConsentSchema = z.object({
  kind: consentKindSchema,
  /** The version of the text agreed to (the setting `consent_<kind>_version` at that moment). */
  version: z.string(),
  at: z.iso.datetime(),
  /** Whether this is the current version of the text. */
  current: z.boolean(),
});

export type AccountConsent = z.infer<typeof accountConsentSchema>;

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
  /**
   * SCREENS M-PRO-04 (TASK-052): whether important events are copied to
   * WhatsApp when a push does not arrive. `false` — the number has no
   * WhatsApp by the last word about it (the login code was confirmed by SMS,
   * or a message was refused «not on WhatsApp»): T-PRO-03.
   */
  whatsappAvailable: z.boolean(),
  /** M-PRO-04 «Напоминания о замене» (TASK-069): off — neither the cards nor the pushes. */
  remindersEnabled: z.boolean(),
  /**
   * TASK-072: the journal of consents, the latest first — «Мои согласия»
   * (M-PRO-06). Older clients ignore it.
   */
  consents: z.array(accountConsentSchema),
  /**
   * TASK-072: a text was updated since the member agreed to it — the app
   * shows «Мы обновили условия» and orders are refused with
   * `CONSENT_REQUIRED` until `POST /account/consents` accepts them.
   */
  consentsOutdated: z.boolean(),
  /** Which consents to give again (empty when `consentsOutdated` is false). */
  outdatedConsents: z.array(consentKindSchema),
});

export type AccountProfile = z.infer<typeof accountProfileSchema>;

/**
 * `POST /account/consents` (TASK-072): «Принять» on «Мы обновили условия»
 * — the consents listed are given for their current versions. Left out,
 * every outdated one is.
 */
export const acceptConsentsBodySchema = z.object({
  kinds: z.array(consentKindSchema).min(1).max(3).optional(),
});

export type AcceptConsentsBody = z.infer<typeof acceptConsentsBodySchema>;

/**
 * Why the account cannot be deleted now (TASK-072, D-077): the last
 * employee of a company (`supplierName` — which), or an administrator.
 */
export const accountDeletionBlockerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("last_member"), supplierId: z.uuid(), supplierName: z.string() }),
  z.object({ kind: z.literal("administrator") }),
]);

export type AccountDeletionBlocker = z.infer<typeof accountDeletionBlockerSchema>;

/**
 * `GET /account/deletion` (SCREENS M-PRO-05, the first screen): what
 * deleting the account will do — the active orders it cancels, the
 * companies it leaves, whether it is refused and why, and where the store
 * subscription is to be cancelled (T-PRO-04).
 */
export const accountDeletionPreviewSchema = z.object({
  activeOrders: z.number().int(),
  /** Companies the member leaves (the membership is removed as a colleague would). */
  supplierMemberships: z.array(z.object({ supplierId: z.uuid(), supplierName: z.string() })),
  /** Not empty — `POST /account/delete` is refused (409 `ACCOUNT_DELETION_REFUSED`). */
  blockers: z.array(accountDeletionBlockerSchema),
  /**
   * The store of a subscription that still renews or runs (T-PRO-04 «Отмените
   * её там»): `ios` — App Store, `android` — Google Play; `null` — none.
   */
  subscriptionPlatform: z.enum(["ios", "android"]).nullable(),
});

export type AccountDeletionPreview = z.infer<typeof accountDeletionPreviewSchema>;

/** `POST /account/delete` (M-PRO-05 «Удалить»): the second step's own confirmation. */
export const deleteAccountBodySchema = z.object({ confirm: z.literal(true) });

export type DeleteAccountBody = z.infer<typeof deleteAccountBodySchema>;

export const accountDeletedResponseSchema = z.object({
  deleted: z.literal(true),
  /** Orders cancelled as an ordinary cancellation by the user. */
  cancelledOrders: z.number().int(),
});

export type AccountDeletedResponse = z.infer<typeof accountDeletedResponseSchema>;

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
    remindersEnabled: z.boolean().optional(),
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
