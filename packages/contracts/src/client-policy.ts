import { z } from "zod";

export const platformPolicySchema = z.object({
  /** Lowest `MAJOR.MINOR.PATCH` still served; lower versions get `CLIENT_UPDATE_REQUIRED`. */
  minSupportedVersion: z.string(),
});

export type PlatformPolicy = z.infer<typeof platformPolicySchema>;

/**
 * `GET /meta/client-policy` (ARCHITECTURE 7.4). Public and always
 * available, whatever the caller's version. `message` is localized by
 * `Accept-Language` and is what a client shows on its "update required"
 * screen — it changes on the server without a client release.
 */
export const clientPolicyResponseSchema = z.object({
  platforms: z.object({
    ios: platformPolicySchema,
    android: platformPolicySchema,
    "supplier-web": platformPolicySchema,
    "admin-web": platformPolicySchema,
  }),
  message: z.string(),
});

export type ClientPolicyResponse = z.infer<typeof clientPolicyResponseSchema>;

/**
 * `GET /meta/club-info` (TASK-077): the club's documents and contact for
 * «Документы и поддержка» (M-PRO-06), and the page «Стать партнёром клуба»
 * (S-PUB-01) opens in the browser. Public, read like the client policy (the
 * settings `club_*`, applied within 30 s). `null` — not set: the app shows
 * no item for it, not a placeholder.
 */
export const clubInfoResponseSchema = z.object({
  termsUrl: z.string().nullable(),
  privacyUrl: z.string().nullable(),
  /** «Связаться с клубом» by phone (and WhatsApp on that number): `+7XXXXXXXXXX`. */
  supportPhone: z.string().nullable(),
  /** «Связаться с клубом» by a link (e.g. `https://wa.me/…`), when no phone is set. */
  supportUrl: z.string().nullable(),
  partnerFormUrl: z.string().nullable(),
});

export type ClubInfoResponse = z.infer<typeof clubInfoResponseSchema>;
