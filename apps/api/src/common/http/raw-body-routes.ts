import type { ApiUploadBodyDefinition } from "@adclub/contracts";

/**
 * Routes outside the client contract whose body the HTTP layer reads as
 * bytes (TASK-024, ARCHITECTURE 4.35). The contract's own upload routes
 * are found in the contract itself (`upload-routes.ts`); this is the short
 * list of the ones that are not in it, and it lives here — with the layer
 * that reads bodies — so nothing of `common` has to reach into a module.
 *
 * The provider's webhook is the only one. It is outside the contract for
 * the same reasons `/metrics` is: no client of ours calls it, and the
 * subscription check answers the provider's challenge as plain text rather
 * than JSON. Its rate limit is still the one mechanism every route uses
 * (`RateLimitedNonContractRoute`).
 */
export const WHATSAPP_WEBHOOK_PATH = "/webhooks/whatsapp";

/**
 * The body is read as bytes, not parsed: the signature is over exactly
 * what was sent, and re-serialising parsed JSON would not reproduce it.
 * The ceiling is the most the server will ever hold for one event —
 * a delivery of statuses is a few kilobytes; anything far above that is
 * not the provider.
 */
export const WHATSAPP_WEBHOOK_BODY: ApiUploadBodyDefinition = {
  description: "The provider's webhook event, as sent (the signature is over these bytes).",
  contentTypes: ["application/json"],
  maxBytes: 256 * 1024,
};

/**
 * The card processor's webhook (TASK-042, ARCHITECTURE 4.77): the same kind
 * of route — outside the client contract, the signature over the bytes as
 * they came, so the body is read as bytes and parsed only after the
 * signature has been checked.
 */
export const PAYMENT_WEBHOOK_PATH = "/webhooks/payments";

/**
 * The stores' notifications (TASK-041, ARCHITECTURE 4.98): App Store Server
 * Notifications V2 (a JWS in `signedPayload`, checked up to Apple's root)
 * and Google Play's Pub/Sub push (an OIDC token in `Authorization`, checked
 * before the body is read). Outside the client contract like the other
 * webhooks; the body is read as bytes and parsed only after the check.
 */
export const APPLE_STORE_WEBHOOK_PATH = "/webhooks/stores/apple";
export const GOOGLE_STORE_WEBHOOK_PATH = "/webhooks/stores/google";

export const STORE_WEBHOOK_BODY: ApiUploadBodyDefinition = {
  description: "A store's notification, as sent (it is checked before it is read).",
  contentTypes: ["application/json"],
  maxBytes: 128 * 1024,
};

export const PAYMENT_WEBHOOK_BODY: ApiUploadBodyDefinition = {
  description: "The payment provider's webhook event, as sent (the signature is over these bytes).",
  contentTypes: ["application/json"],
  maxBytes: 64 * 1024,
};
