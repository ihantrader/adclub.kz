import { z } from "zod";
import { sessionAccessSchema, supplierSummarySchema } from "./access";
import { sessionTokensSchema } from "./session";

/**
 * An unfinished sign-in (choosing a company, the admin second factor).
 * The token proves the login code was entered: send it with the next step.
 * It works once and only until `expiresAt`; after that, sign in again.
 * It works only together with the HttpOnly step cookie the same response
 * set: send the next step from the same browser, with credentials
 * (`credentials: "include"`). Anyone else holding the token gets
 * `SIGN_IN_STEP_INVALID`.
 */
export const signInStepSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
});

export type SignInStep = z.infer<typeof signInStepSchema>;

const signInStepTokenSchema = z.string().min(1).max(256);

/**
 * `details` of `SUPPLIER_SELECTION_REQUIRED`: the number works for several
 * companies — show them and send the choice to
 * `POST /auth/sign-in/supplier` (no new code needed).
 */
export const supplierSelectionRequiredDetailsSchema = z.object({
  signInStep: signInStepSchema,
  suppliers: z.array(supplierSummarySchema),
});

export type SupplierSelectionRequiredDetails = z.infer<
  typeof supplierSelectionRequiredDetailsSchema
>;

/**
 * `details` of `TOTP_SETUP_REQUIRED` (first admin sign-in, or after a
 * reset: `POST /auth/sign-in/totp/setup`, then `/confirm`) and of
 * `TOTP_REQUIRED` (`POST /auth/sign-in/totp`).
 */
export const totpStepRequiredDetailsSchema = z.object({
  signInStep: signInStepSchema,
});

export type TotpStepRequiredDetails = z.infer<typeof totpStepRequiredDetailsSchema>;

/** `POST /auth/sign-in/supplier`: the company chosen on the selection screen. */
export const selectSupplierBodySchema = z.object({
  signInStep: signInStepTokenSchema,
  supplierId: z.uuid(),
  /** Shown in the list of sessions, as in `verify`. */
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^\P{Cc}*$/u, "Must not contain control characters")
    .optional(),
});

export type SelectSupplierBody = z.infer<typeof selectSupplierBodySchema>;

/** A finished sign-in into the supplier cabinet or the admin panel. */
export const signInCompletedResponseSchema = z.object({
  status: z.literal("signed_in"),
  accountId: z.uuid(),
  /** Web sessions: the refresh token is in the HttpOnly cookie, not here. */
  session: sessionTokensSchema,
  access: sessionAccessSchema,
});

export type SignInCompletedResponse = z.infer<typeof signInCompletedResponseSchema>;

/** `POST /auth/sign-in/totp/setup`: start (or repeat) setting up the authenticator app. */
export const totpSetupBodySchema = z.object({
  signInStep: signInStepTokenSchema,
});

export type TotpSetupBody = z.infer<typeof totpSetupBodySchema>;

/**
 * What the authenticator app needs. `otpauthUri` is the content of the QR
 * code to show; `secret` (base32) is for manual entry. Returned only
 * during the setup step and never again; repeating the request within the
 * same step returns the same secret.
 */
export const totpSetupResponseSchema = z.object({
  otpauthUri: z.string(),
  secret: z.string(),
  issuer: z.string(),
  accountName: z.string(),
  digits: z.number().int(),
  periodSeconds: z.number().int(),
  algorithm: z.literal("SHA1"),
});

export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

export const totpCodeSchema = z.string().regex(/^\d{6}$/, "Must be 6 digits");

/**
 * One-time backup code as shown to the administrator (`xxxx-xxxx`); case,
 * spaces and the dash are ignored when it is typed in.
 */
const backupCodeInputSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9\s-]+$/, "Must contain only letters, digits, spaces and -");

/** `POST /auth/sign-in/totp/setup/confirm`: the current code from the app. */
export const totpSetupConfirmBodySchema = z.object({
  signInStep: signInStepTokenSchema,
  totpCode: totpCodeSchema,
  deviceName: selectSupplierBodySchema.shape.deviceName,
});

export type TotpSetupConfirmBody = z.infer<typeof totpSetupConfirmBodySchema>;

/**
 * The set of one-time backup codes. Shown once: the server keeps only a
 * form they can't be recovered from.
 */
export const backupCodesSchema = z.array(z.string());

/** The authenticator is set up: the admin session and the backup codes (shown once). */
export const totpSetupCompletedResponseSchema = signInCompletedResponseSchema.extend({
  backupCodes: backupCodesSchema,
});

export type TotpSetupCompletedResponse = z.infer<typeof totpSetupCompletedResponseSchema>;

/**
 * `POST /auth/sign-in/totp`: exactly one of the current code from the
 * authenticator app or an unused backup code.
 */
export const totpVerifyBodySchema = z
  .object({
    signInStep: signInStepTokenSchema,
    totpCode: totpCodeSchema.optional(),
    backupCode: backupCodeInputSchema.optional(),
    deviceName: selectSupplierBodySchema.shape.deviceName,
  })
  .refine((body) => (body.totpCode === undefined) !== (body.backupCode === undefined), {
    message: "Send exactly one of totpCode and backupCode",
    path: ["totpCode"],
  });

export type TotpVerifyBody = z.infer<typeof totpVerifyBodySchema>;

export const totpVerifiedResponseSchema = signInCompletedResponseSchema.extend({
  /** Unused backup codes left (a used one is gone for good). */
  backupCodesRemaining: z.number().int(),
});

export type TotpVerifiedResponse = z.infer<typeof totpVerifiedResponseSchema>;
