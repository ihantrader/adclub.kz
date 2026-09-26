import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signature of the provider's webhook (TASK-024 requirement 4;
 * ARCHITECTURE 9.1, 4.35). Meta signs the raw body with the app secret and
 * sends `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Nothing of a webhook is looked at before this passes: a body with no
 * signature, with a malformed one or with one computed from another secret
 * is refused and never parsed, so an event nobody could have signed cannot
 * change a thing. The comparison is constant time — a byte-by-byte one
 * would tell an attacker how much of a guess was right.
 */

export const WEBHOOK_SIGNATURE_HEADER = "x-hub-signature-256";

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/** True when `signature` is the app secret's signature of exactly these bytes. */
export function isValidWebhookSignature(
  body: Buffer,
  signature: string | undefined,
  appSecret: string,
): boolean {
  const match = SIGNATURE.exec((signature ?? "").trim().toLowerCase());
  if (!match) {
    return false;
  }
  const expected = signWebhookBody(body, appSecret);
  const given = Buffer.from(match[1]!, "hex");
  const mine = Buffer.from(expected, "hex");
  // Equal lengths by construction (both 32 bytes), but never assume it.
  return given.length === mine.length && timingSafeEqual(given, mine);
}

/** The hex signature of a body — what the provider sends, and what development signs with. */
export function signWebhookBody(body: Buffer, appSecret: string): string {
  return createHmac("sha256", appSecret).update(body).digest("hex");
}

/** The header value of a signed body. */
export function webhookSignatureHeader(body: Buffer, appSecret: string): string {
  return `sha256=${signWebhookBody(body, appSecret)}`;
}

/**
 * What identifies one delivery of the webhook. The provider sends no
 * delivery id and repeats a delivery byte for byte until it gets a 200, so
 * the digest of the body is the identity: the same delivery twice is the
 * same row (`inbound_webhook_event.external_id` is unique), and a different
 * event — even one second apart, since it carries its own timestamps and
 * message ids — is a different one.
 */
export function webhookEventId(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The subscription check Meta makes before it starts sending
 * (`GET …?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`): the
 * token must be ours, and the challenge is echoed back as it came.
 */
export function verifySubscription(
  query: Record<string, unknown>,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false; reason: string } {
  const mode = stringOf(query["hub.mode"]);
  const token = stringOf(query["hub.verify_token"]);
  const challenge = stringOf(query["hub.challenge"]);
  if (mode !== "subscribe") {
    return { ok: false, reason: "hub.mode must be subscribe" };
  }
  if (!challenge) {
    return { ok: false, reason: "hub.challenge is missing" };
  }
  if (!token || !equalInConstantTime(token, verifyToken)) {
    return { ok: false, reason: "hub.verify_token does not match" };
  }
  return { ok: true, challenge };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function equalInConstantTime(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Different lengths are told apart without a comparison, which is what
  // the length of the answer would reveal anyway; the contents are not.
  return a.length === b.length && timingSafeEqual(a, b);
}
