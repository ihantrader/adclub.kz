import { describe, expect, it } from "vitest";
import {
  isValidWebhookSignature,
  signWebhookBody,
  verifySubscription,
  webhookEventId,
  webhookSignatureHeader,
} from "./webhook-signature";

const SECRET = "an-app-secret-of-the-meta-app";
const BODY = Buffer.from(
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [] }] }),
  "utf8",
);

describe("the signature of the provider's webhook (TASK-024 requirement 4)", () => {
  it("accepts the signature of exactly these bytes with this secret", () => {
    expect(isValidWebhookSignature(BODY, webhookSignatureHeader(BODY, SECRET), SECRET)).toBe(true);
  });

  it("matches a known HMAC-SHA256, so it is the algorithm Meta uses and not merely self-consistent", () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
    expect(signWebhookBody(Buffer.from("what do ya want for nothing?"), "Jefe")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("refuses no signature, an empty one and a malformed one", () => {
    expect(isValidWebhookSignature(BODY, undefined, SECRET)).toBe(false);
    expect(isValidWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(isValidWebhookSignature(BODY, "sha256=", SECRET)).toBe(false);
    expect(isValidWebhookSignature(BODY, "sha256=zz", SECRET)).toBe(false);
    // Not hex, though the right length.
    expect(isValidWebhookSignature(BODY, `sha256=${"g".repeat(64)}`, SECRET)).toBe(false);
    // The digest without its prefix, and another algorithm's prefix.
    expect(isValidWebhookSignature(BODY, signWebhookBody(BODY, SECRET), SECRET)).toBe(false);
    expect(isValidWebhookSignature(BODY, `sha1=${signWebhookBody(BODY, SECRET)}`, SECRET)).toBe(
      false,
    );
  });

  it("refuses the signature of another secret", () => {
    expect(
      isValidWebhookSignature(
        BODY,
        webhookSignatureHeader(BODY, "another-secret-entirely"),
        SECRET,
      ),
    ).toBe(false);
  });

  it("refuses a body changed by a single byte, and one signed as parsed-and-written-again JSON", () => {
    const header = webhookSignatureHeader(BODY, SECRET);
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(isValidWebhookSignature(tampered, header, SECRET)).toBe(false);
    // Same JSON, different bytes (whitespace): not what was signed.
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2));
    expect(isValidWebhookSignature(reformatted, header, SECRET)).toBe(false);
    expect(isValidWebhookSignature(Buffer.alloc(0), header, SECRET)).toBe(false);
  });

  it("refuses a truncated or extended signature", () => {
    const header = webhookSignatureHeader(BODY, SECRET);
    expect(isValidWebhookSignature(BODY, header.slice(0, -2), SECRET)).toBe(false);
    expect(isValidWebhookSignature(BODY, `${header}00`, SECRET)).toBe(false);
  });

  it("signs an empty body all the same (a signed nothing is still verifiable)", () => {
    const empty = Buffer.alloc(0);
    expect(isValidWebhookSignature(empty, webhookSignatureHeader(empty, SECRET), SECRET)).toBe(
      true,
    );
  });
});

describe("the identity of a delivery", () => {
  it("is the same for the same bytes and different for any other", () => {
    expect(webhookEventId(BODY)).toBe(webhookEventId(Buffer.from(BODY)));
    expect(webhookEventId(BODY)).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookEventId(BODY)).not.toBe(webhookEventId(Buffer.from(`${BODY.toString()} `)));
  });
});

describe("confirming the subscription", () => {
  const TOKEN = "the-verify-token-of-ours";

  it("echoes the challenge back when the token is ours", () => {
    expect(
      verifySubscription(
        { "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "1158201444" },
        TOKEN,
      ),
    ).toEqual({ ok: true, challenge: "1158201444" });
  });

  it("refuses another token, no token, another mode and no challenge", () => {
    const good = { "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "42" };
    expect(verifySubscription({ ...good, "hub.verify_token": "nope" }, TOKEN).ok).toBe(false);
    expect(verifySubscription({ ...good, "hub.verify_token": TOKEN.slice(1) }, TOKEN).ok).toBe(
      false,
    );
    expect(verifySubscription({ ...good, "hub.verify_token": undefined }, TOKEN).ok).toBe(false);
    expect(verifySubscription({ ...good, "hub.mode": "unsubscribe" }, TOKEN).ok).toBe(false);
    expect(verifySubscription({ ...good, "hub.challenge": "" }, TOKEN).ok).toBe(false);
    expect(verifySubscription({}, TOKEN).ok).toBe(false);
    // A repeated query parameter arrives as an array: never a token.
    expect(verifySubscription({ ...good, "hub.verify_token": [TOKEN, TOKEN] }, TOKEN).ok).toBe(
      false,
    );
  });

  it("never says the token in its reason", () => {
    const result = verifySubscription(
      { "hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1" },
      TOKEN,
    );
    expect(result).toEqual({ ok: false, reason: "hub.verify_token does not match" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
