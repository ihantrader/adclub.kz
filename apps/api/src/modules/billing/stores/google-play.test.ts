import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GoogleStoreConfig } from "../../../config";
import { devGoogleOidcToken, devPubsubPush } from "./dev-store-signing";
import { googleNotificationTypes, GooglePlay, googleRef, googleStateEvents } from "./google-play";
import { signRs256Jwt } from "./signatures";
import { StorePurchaseRefusedError, StoreUnavailableError } from "./store-word";

/**
 * Google Play of TASK-041 without Google: every row of the table of
 * Real-time Developer Notifications and of the subscription's states, the
 * OIDC token of the Pub/Sub push (the local key, Google's keys from a
 * substituted JWKS, every way it can be wrong), the push itself, and the
 * Play Developer API — the token exchange, the state, the acknowledgement.
 */

const ACCOUNT = "6f2a1c84-55a0-4d1e-9a52-0e6a7c1b3d10";
const AUDIENCE = "https://adclub.test/webhooks/stores/google";
const SENDER = "pubsub@adclub.iam.gserviceaccount.com";
const serviceKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

function config(overrides: Partial<GoogleStoreConfig> = {}): GoogleStoreConfig {
  return {
    configured: true,
    packageName: "kz.adclub.app",
    api: {
      clientEmail: "play@adclub.iam.gserviceaccount.com",
      privateKey: serviceKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      tokenUrl: "https://token.test/token",
    },
    apiUrl: "https://play.test",
    pubsub: { audience: AUDIENCE, serviceAccount: SENDER },
    certsUrl: "https://certs.test/certs",
    devTrust: true,
    ...overrides,
  };
}

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: AUDIENCE,
  email: SENDER,
  email_verified: true,
  iat: nowS(),
  exp: nowS() + 600,
  ...overrides,
});

function routes(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = handler(url, init);
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
      }),
    );
  };
  return { fetch, calls };
}

const certs = {
  keys: [
    { ...googleKey.publicKey.export({ format: "jwk" }), kid: "google-1", alg: "RS256", use: "sig" },
  ],
};

async function refusedWith(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StorePurchaseRefusedError);
    return (error as StorePurchaseRefusedError).reason;
  }
  throw new Error("not refused");
}

describe("the table of Real-time Developer Notifications", () => {
  const play = new GooglePlay(config());

  it.each(Object.entries(googleNotificationTypes))("%s → %o", (code, row) => {
    const read = play.readPush(
      devPubsubPush(
        {
          version: "1.0",
          packageName: "kz.adclub.app",
          eventTimeMillis: "1795000000000",
          subscriptionNotification: {
            version: "1.0",
            notificationType: Number(code),
            purchaseToken: "tok-1",
          },
        },
        `msg-${code}`,
      ),
    );
    expect(read).toEqual({
      notificationId: `msg-${code}`,
      name: `${code}:${row!.name}`,
      eventAt: new Date(1795000000000),
      action: row!.action,
      purchaseToken: "tok-1",
    });
  });

  it("keeps an unknown code, a test notification; a voided subscription ends it, a partial refund doesn't", () => {
    const push = (body: Record<string, unknown>) =>
      play.readPush(
        devPubsubPush(
          { version: "1.0", packageName: "kz.adclub.app", eventTimeMillis: 1795000000000, ...body },
          "m",
        ),
      );
    expect(
      push({ subscriptionNotification: { notificationType: 99, purchaseToken: "t" } }),
    ).toMatchObject({ name: "unknown:99", action: "unknown" });
    expect(push({ testNotification: { version: "1.0" } })).toMatchObject({
      name: "test",
      action: "ignored",
    });
    expect(
      push({
        voidedPurchaseNotification: {
          purchaseToken: "t",
          orderId: "GPA.1",
          productType: 1,
          refundType: 1,
        },
      }),
    ).toMatchObject({ action: "refunded", purchaseToken: "t" });
    expect(
      push({ voidedPurchaseNotification: { purchaseToken: "t", productType: 1, refundType: 2 } }),
    ).toMatchObject({ action: "ignored" });
    expect(
      push({ voidedPurchaseNotification: { purchaseToken: "t", productType: 2, refundType: 1 } }),
    ).toMatchObject({ action: "ignored" });
  });

  it("refuses another app's notification and what isn't a push", () => {
    expect(() =>
      play.readPush(
        devPubsubPush(
          {
            packageName: "com.other",
            eventTimeMillis: "1",
            subscriptionNotification: { notificationType: 4, purchaseToken: "t" },
          },
          "m",
        ),
      ),
    ).toThrow(StorePurchaseRefusedError);
    expect(() => play.readPush({ nothing: true })).toThrow(StorePurchaseRefusedError);
  });
});

describe("the table of subscription states", () => {
  const end = new Date("2026-11-16T00:00:00Z");
  it.each(Object.entries(googleStateEvents))("%s", (state, say) => {
    const steps = say!(end);
    const expected: Record<string, string[]> = {
      SUBSCRIPTION_STATE_ACTIVE: ["renewed", "cancel_withdrawn"],
      SUBSCRIPTION_STATE_CANCELED: ["renewed", "cancelled"],
      SUBSCRIPTION_STATE_IN_GRACE_PERIOD: ["grace_started"],
      SUBSCRIPTION_STATE_ON_HOLD: ["suspended"],
      SUBSCRIPTION_STATE_PAUSED: ["suspended"],
      SUBSCRIPTION_STATE_EXPIRED: ["expired"],
      SUBSCRIPTION_STATE_PENDING: [],
      SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: [],
      SUBSCRIPTION_STATE_UNSPECIFIED: [],
    };
    expect(steps.map((step) => step.kind)).toEqual(expected[state]);
    if (state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD") expect(steps[0]!.graceUntil).toEqual(end);
  });
});

describe("the OIDC token of the Pub/Sub push", () => {
  it("takes the local key in development and tests, Google's keys from their JWKS", async () => {
    const { fetch, calls } = routes(() => ({ status: 200, body: certs }));
    const play = new GooglePlay(config(), fetch);
    await play.verifyPush(`Bearer ${devGoogleOidcToken(claims())}`);
    expect(calls).toHaveLength(0);
    const google = signRs256Jwt(
      { kid: "google-1" },
      claims(),
      googleKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    await play.verifyPush(`Bearer ${google}`);
    await play.verifyPush(`Bearer ${google}`);
    expect(calls.map((call) => call.url)).toEqual(["https://certs.test/certs"]);
  });

  it("refuses no token, a wrong audience, sender, issuer, an expired one, an unknown key, a forged one", async () => {
    const play = new GooglePlay(config(), routes(() => ({ status: 200, body: certs })).fetch);
    expect(await refusedWith(play.verifyPush(undefined))).toBe("signature");
    expect(await refusedWith(play.verifyPush("Basic x"))).toBe("signature");
    for (const bad of [
      { aud: "https://someone-else.test" },
      { email: "intruder@evil.iam.gserviceaccount.com" },
      { email_verified: false },
      { iss: "https://evil.test" },
      { exp: nowS() - 3600 },
    ]) {
      expect(await refusedWith(play.verifyPush(`Bearer ${devGoogleOidcToken(claims(bad))}`))).toBe(
        "signature",
      );
    }
    const unknown = signRs256Jwt(
      { kid: "nobody" },
      claims(),
      googleKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    expect(await refusedWith(play.verifyPush(`Bearer ${unknown}`))).toBe("signature");
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = signRs256Jwt(
      { kid: "google-1" },
      claims(),
      otherKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    expect(await refusedWith(play.verifyPush(`Bearer ${forged}`))).toBe("signature");
  });

  it("does not trust the local key outside development, and refuses all without a subscription", async () => {
    const deployed = new GooglePlay(
      config({ devTrust: false }),
      routes(() => ({ status: 200, body: certs })).fetch,
    );
    expect(await refusedWith(deployed.verifyPush(`Bearer ${devGoogleOidcToken(claims())}`))).toBe(
      "signature",
    );
    const unconfigured = new GooglePlay(config({ pubsub: null }));
    await expect(unconfigured.verifyPush("Bearer a.b.c")).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
    const keysDown = new GooglePlay(
      config({ devTrust: false }),
      routes(() => ({ status: 503 })).fetch,
    );
    const google = signRs256Jwt(
      { kid: "google-1" },
      claims(),
      googleKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    await expect(keysDown.verifyPush(`Bearer ${google}`)).rejects.toBeInstanceOf(
      StoreUnavailableError,
    );
  });
});

describe("the Play Developer API (a substituted fetch)", () => {
  const purchase = (state: string, overrides: Record<string, unknown> = {}) => ({
    kind: "androidpublisher#subscriptionPurchaseV2",
    subscriptionState: state,
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: ACCOUNT },
    lineItems: [{ productId: "club_month", expiryTime: "2026-11-16T00:00:00Z" }],
    testPurchase: {},
    ...overrides,
  });

  it("exchanges the service account's assertion once, reads the state, acknowledges", async () => {
    const { fetch, calls } = routes((url) =>
      url === "https://token.test/token"
        ? { status: 200, body: { access_token: "access-1", expires_in: 3600 } }
        : url.includes(":acknowledge")
          ? { status: 200, body: {} }
          : { status: 200, body: purchase("SUBSCRIPTION_STATE_ACTIVE") },
    );
    const play = new GooglePlay(config(), fetch);
    const state = await play.state("purchase-token-1");
    await play.state("purchase-token-1");
    expect(state!.acknowledged).toBe(false);
    expect(state!.word.facts).toMatchObject({
      platform: "android",
      providerRef: googleRef("purchase-token-1"),
      environment: "sandbox",
      productId: "club_month",
      accountId: ACCOUNT,
      word: "SUBSCRIPTION_STATE_ACTIVE",
    });
    expect(state!.word.facts.providerRef).not.toContain("purchase-token-1");
    expect(state!.word.events.map((event) => event.kind)).toEqual(["renewed", "cancel_withdrawn"]);
    expect(calls.filter((call) => call.url === "https://token.test/token")).toHaveLength(1);
    expect(calls[1]!.url).toBe(
      "https://play.test/androidpublisher/v3/applications/kz.adclub.app/purchases/subscriptionsv2/tokens/purchase-token-1",
    );
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer access-1",
    );
    const assertion = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
    const assertionClaims = JSON.parse(
      Buffer.from(assertion.split(".")[1]!, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(assertionClaims).toMatchObject({
      iss: "play@adclub.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://token.test/token",
    });
    await play.acknowledge("club_month", "purchase-token-1");
    expect(calls.at(-1)!.url).toBe(
      "https://play.test/androidpublisher/v3/applications/kz.adclub.app/purchases/subscriptions/club_month/tokens/purchase-token-1:acknowledge",
    );
  });

  it("answers null for an unknown token, refuses a malformed one, and «unavailable» otherwise", async () => {
    const answering = (status: number, body?: unknown) =>
      new GooglePlay(
        config(),
        routes((url) =>
          url === "https://token.test/token"
            ? { status: 200, body: { access_token: "a", expires_in: 3600 } }
            : { status, body },
        ).fetch,
      );
    expect(await answering(404).state("t")).toBeNull();
    expect(await answering(410).state("t")).toBeNull();
    expect(await refusedWith(answering(400).state("t"))).toBe("not_found");
    await expect(answering(503).state("t")).rejects.toMatchObject({ reason: "http_503" });
    await expect(answering(401).state("t")).rejects.toMatchObject({ reason: "auth" });
    await expect(answering(200, { what: 1 }).state("t")).rejects.toMatchObject({
      reason: "malformed",
    });
    const noToken = new GooglePlay(config(), routes(() => ({ status: 500 })).fetch);
    await expect(noToken.state("t")).rejects.toMatchObject({ reason: "auth" });
    await expect(new GooglePlay(config({ api: null })).state("t")).rejects.toMatchObject({
      reason: "not_configured",
    });
  });

  it("takes production for a purchase that is not a test one, and the hinted product's line", async () => {
    const play = new GooglePlay(
      config(),
      routes((url) =>
        url === "https://token.test/token"
          ? { status: 200, body: { access_token: "a", expires_in: 3600 } }
          : {
              status: 200,
              body: purchase("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", {
                testPurchase: undefined,
                lineItems: [
                  { productId: "other", expiryTime: "2026-10-01T00:00:00Z" },
                  { productId: "club_month", expiryTime: "2026-12-01T00:00:00Z" },
                ],
              }),
            },
      ).fetch,
    );
    const state = await play.state("t", "club_month");
    expect(state!.word.facts.environment).toBe("production");
    expect(state!.word.events).toMatchObject([
      { kind: "grace_started", graceUntil: new Date("2026-12-01T00:00:00Z") },
    ]);
  });
});
