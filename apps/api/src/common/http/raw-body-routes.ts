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
