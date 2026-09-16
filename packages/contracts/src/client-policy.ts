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
