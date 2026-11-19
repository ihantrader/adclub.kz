import { createHash, generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppleStoreConfig } from "../../../config";
import { APPLE_ROOT_CA_G3_PEM, APPLE_ROOT_CA_G3_SHA256 } from "./apple-root-ca";
import { appleNotificationEvent, appleNotificationEvents, AppStore } from "./app-store";
import { devAppleJws, type DevChain } from "./dev-store-signing";
import { oidDer } from "./signatures";
import { StorePurchaseRefusedError, StoreUnavailableError } from "./store-word";

/**
 * The App Store of TASK-041 without Apple: the root pinned by its
 * fingerprint, every row of the table of notifications, the check of the
 * signature (Apple's chain, the expired and the rogue ones, a payload
 * changed after signing, another app, another environment), and the App
 * Store Server API on a substituted `fetch` — the statuses 1–5, its errors
 * and the token we sign for it.
 */

const ACCOUNT = "6f2a1c84-55a0-4d1e-9a52-0e6a7c1b3d10";
const apiKey = generateKeyPairSync("ec", { namedCurve: "P-256" });

function config(overrides: Partial<AppleStoreConfig> = {}): AppleStoreConfig {
  return {
    configured: true,
    bundleId: "kz.adclub.app",
    appAppleId: 1234567890,
    environments: ["sandbox"],
    api: {
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      keyId: "2X9R4HXF34",
      privateKey: apiKey.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    },
    apiUrls: { production: "https://prod.test", sandbox: "https://sandbox.test" },
    devTrust: true,
    ...overrides,
  };
}

function transaction(overrides: Record<string, unknown> = {}, chain: DevChain = "dev"): string {
  return devAppleJws(
    {
      transactionId: "2000000111",
      originalTransactionId: "2000000100",
      bundleId: "kz.adclub.app",
      productId: "kz.adclub.club.month",
      type: "Auto-Renewable Subscription",
      purchaseDate: Date.UTC(2026, 9, 16),
      expiresDate: Date.UTC(2026, 10, 16),
      signedDate: Date.UTC(2026, 9, 16),
      environment: "Sandbox",
      appAccountToken: ACCOUNT,
      ...overrides,
    },
    chain,
  );
}

function renewal(overrides: Record<string, unknown> = {}): string {
  return devAppleJws({
    originalTransactionId: "2000000100",
    autoRenewStatus: 1,
    signedDate: Date.UTC(2026, 9, 16),
    environment: "Sandbox",
    ...overrides,
  });
}

function notification(
  type: string,
  subtype: string | undefined,
  data: Record<string, unknown> = {},
  chain: DevChain = "dev",
): string {
  return devAppleJws(
    {
      notificationType: type,
      ...(subtype && { subtype }),
      notificationUUID: `uuid-${type}-${subtype ?? "-"}`,
      version: "2.0",
      signedDate: Date.UTC(2026, 9, 16, 12),
      data: {
        bundleId: "kz.adclub.app",
        environment: "Sandbox",
        signedTransactionInfo: transaction(),
        signedRenewalInfo: renewal({ gracePeriodExpiresDate: Date.UTC(2026, 11, 1) }),
        ...data,
      },
    },
    chain,
  );
}

describe("Apple Root CA - G3", () => {
  it("is the root Apple publishes: its SHA-256 fingerprint is pinned", () => {
    const root = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(root.fingerprint256).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(root.subject).toContain("CN=Apple Root CA - G3");
    expect(root.ca).toBe(true);
    expect(new Date(root.validTo).getUTCFullYear()).toBe(2039);
    expect(createHash("sha256").update(root.raw).digest("hex").toUpperCase()).toBe(
      APPLE_ROOT_CA_G3_SHA256.replaceAll(":", ""),
    );
  });

  it("encodes Apple's markers as DER", () => {
    expect(oidDer("1.2.840.113635.100.6.11.1").toString("hex")).toBe("060a2a864886f76364060b01");
  });
});

describe("the table of App Store Server Notifications V2", () => {
  const store = new AppStore(config());
  const rows = Object.entries(appleNotificationEvents);

  it.each(rows)("%s → %s", (key, kind) => {
    const [type, subtype] = key.split("/") as [string, string | undefined];
    const read = store.readNotification(notification(type, subtype));
    expect(read.name).toBe(key);
    if (kind === "ignored") {
      expect(read.result).toBe("ignored");
      expect(read.word?.events ?? []).toEqual([]);
      return;
    }
    expect(read.result).toBe("events");
    const [event] = read.word!.events;
    expect(event).toMatchObject({
      providerEventId: `apple:uuid-${type}-${subtype ?? "-"}`,
      kind,
      providerRef: "apple:2000000100",
      accountId: ACCOUNT,
      productId: "kz.adclub.club.month",
      platform: "ios",
      eventAt: new Date(Date.UTC(2026, 9, 16, 12)),
    });
    if (kind === "started" || kind === "renewed") {
      expect(event!.periodEnd).toEqual(new Date(Date.UTC(2026, 10, 16)));
    }
    if (kind === "grace_started") {
      // The grace's end is the store's, never computed.
      expect(event!.graceUntil).toEqual(new Date(Date.UTC(2026, 11, 1)));
    }
  });

  it("reads a subtype's own row before its type's, and keeps an unknown name with no events", () => {
    expect(appleNotificationEvent("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toBe("grace_started");
    expect(appleNotificationEvent("DID_FAIL_TO_RENEW", null)).toBe("suspended");
    expect(appleNotificationEvent("EXPIRED", "SOMETHING_NEW")).toBe("expired");
    expect(appleNotificationEvent("BRAND_NEW_TYPE", null)).toBeNull();
    const read = store.readNotification(notification("BRAND_NEW_TYPE", undefined));
    expect(read).toMatchObject({ result: "unknown", word: null, name: "BRAND_NEW_TYPE" });
  });

  it("says nothing for a grace without its end (the reconciliation asks the API)", () => {
    const read = store.readNotification(
      notification("DID_FAIL_TO_RENEW", "GRACE_PERIOD", { signedRenewalInfo: renewal() }),
    );
    expect(read.result).toBe("ignored");
    expect(read.word?.events).toEqual([]);
  });
});

describe("the signature of the App Store", () => {
  const store = new AppStore(config());
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(StorePurchaseRefusedError);
      return (error as StorePurchaseRefusedError).reason;
    }
    throw new Error("not refused");
  };

  it("takes the local chain in development and tests, and Apple's root always", () => {
    expect(store.readTransaction(transaction()).originalTransactionId).toBe("2000000100");
    // A deployed server doesn't trust the local root: the same JWS is refused.
    const deployed = new AppStore(config({ devTrust: false }));
    expect(refusal(() => deployed.readTransaction(transaction()))).toBe("signature");
  });

  it("refuses a rogue chain, an expired certificate and a payload changed after signing", () => {
    expect(refusal(() => store.readTransaction(transaction({}, "rogue")))).toBe("signature");
    expect(refusal(() => store.readTransaction(transaction({}, "expired")))).toBe("signature");
    const [header, , signature] = transaction().split(".");
    const forged = Buffer.from(
      JSON.stringify({
        originalTransactionId: "2000000100",
        bundleId: "kz.adclub.app",
        productId: "x",
      }),
    ).toString("base64url");
    expect(refusal(() => store.readTransaction(`${header}.${forged}.${signature}`))).toBe(
      "signature",
    );
    expect(refusal(() => store.readNotification("not.a.jws"))).toBe("signature");
    expect(
      refusal(() => store.readNotification(notification("DID_RENEW", undefined, {}, "rogue"))),
    ).toBe("signature");
  });

  it("refuses another app, another environment, another app's Apple ID, not a subscription", () => {
    expect(refusal(() => store.readTransaction(transaction({ bundleId: "com.other.app" })))).toBe(
      "bundle",
    );
    expect(refusal(() => store.readTransaction(transaction({ environment: "Production" })))).toBe(
      "environment",
    );
    expect(
      refusal(() =>
        store.readNotification(notification("DID_RENEW", undefined, { bundleId: "com.other.app" })),
      ),
    ).toBe("bundle");
    const production = new AppStore(config({ environments: ["production"] }));
    expect(
      refusal(() =>
        production.readNotification(
          notification("DID_RENEW", undefined, {
            environment: "Production",
            appAppleId: 999,
            signedTransactionInfo: transaction({ environment: "Production" }),
          }),
        ),
      ),
    ).toBe("bundle");
    expect(
      refusal(() =>
        store.readTransaction(transaction({ type: "Non-Consumable", expiresDate: undefined })),
      ),
    ).toBe("not_subscription");
  });
});

describe("the App Store Server API (a substituted fetch)", () => {
  type Answer = { status: number; body?: unknown };
  function storeAnswering(answer: Answer | Error) {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new AppStore(config(), (url, init) => {
      calls.push({ url, init });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(
        new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
          status: answer.status,
        }),
      );
    });
    return { store, calls };
  }
  function statusBody(
    status: number,
    tx: Record<string, unknown> = {},
    rn: Record<string, unknown> = {},
  ) {
    return {
      environment: "Sandbox",
      bundleId: "kz.adclub.app",
      data: [
        {
          subscriptionGroupIdentifier: "21000000",
          lastTransactions: [
            {
              originalTransactionId: "2000000100",
              status,
              signedTransactionInfo: transaction({ signedDate: Date.UTC(2026, 10, 20), ...tx }),
              signedRenewalInfo: renewal({ signedDate: Date.UTC(2026, 10, 20), ...rn }),
            },
          ],
        },
      ],
    };
  }
  const end = new Date(Date.UTC(2026, 10, 16));

  it("asks the sandbox host with an ES256 token of our key (aud, bid, an hour at most)", async () => {
    const { store, calls } = storeAnswering({ status: 200, body: statusBody(1) });
    await store.state("2000000100", "sandbox");
    expect(calls[0]!.url).toBe("https://sandbox.test/inApps/v1/subscriptions/2000000100");
    const bearer = String((calls[0]!.init.headers as Record<string, string>).authorization).slice(
      7,
    );
    const [header, claims, signature] = bearer.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "2X9R4HXF34",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<
      string,
      number | string
    >;
    expect(payload).toMatchObject({
      iss: "57246542-96fe-1a63-e053-0824d011072a",
      aud: "appstoreconnect-v1",
      bid: "kz.adclub.app",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(3600);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: apiKey.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it.each([
    [1, { autoRenewStatus: 1 }, ["renewed", "cancel_withdrawn"]],
    [1, { autoRenewStatus: 0 }, ["renewed", "cancelled"]],
    [2, {}, ["expired"]],
    [3, {}, ["renewed", "suspended"]],
    [4, { gracePeriodExpiresDate: Date.UTC(2026, 11, 2) }, ["renewed", "grace_started"]],
    [5, {}, ["revoked"]],
  ] as const)("status %s with %o says %o", async (status, rn, kinds) => {
    const { store } = storeAnswering({ status: 200, body: statusBody(status, {}, rn) });
    const word = await store.state("2000000100", "sandbox");
    expect(word!.events.map((event) => event.kind)).toEqual(kinds);
    expect(word!.facts).toMatchObject({ word: `status:${String(status)}`, environment: "sandbox" });
    expect(word!.events[0]!.periodEnd ?? word!.events[0]!.graceUntil).toBeTruthy();
    if (status === 4) expect(word!.events[1]!.graceUntil).toEqual(new Date(Date.UTC(2026, 11, 2)));
    if (status === 1) expect(word!.events[0]!.periodEnd).toEqual(end);
    // One state asked twice is the same events: the ids are the state's.
    const again = await store.state("2000000100", "sandbox");
    expect(again!.events.map((event) => event.providerEventId)).toEqual(
      word!.events.map((event) => event.providerEventId),
    );
  });

  it("says refunded for an expired transaction with a revocation date", async () => {
    const { store } = storeAnswering({
      status: 200,
      body: statusBody(2, { revocationDate: Date.UTC(2026, 9, 20) }),
    });
    expect((await store.state("2000000100", "sandbox"))!.events.map((event) => event.kind)).toEqual(
      ["refunded"],
    );
  });

  it("answers null for an unknown transaction and «unavailable» for the rest", async () => {
    expect(await storeAnswering({ status: 404 }).store.state("1", "sandbox")).toBeNull();
    for (const [answer, reason] of [
      [{ status: 401 }, "auth"],
      [{ status: 500 }, "http_500"],
      [{ status: 200, body: { nothing: true } }, "malformed"],
      [new TypeError("fetch failed"), "network"],
      [Object.assign(new Error("timeout"), { name: "TimeoutError" }), "timeout"],
    ] as const) {
      await expect(storeAnswering(answer).store.state("1", "sandbox")).rejects.toMatchObject({
        constructor: StoreUnavailableError,
        reason,
      });
    }
    const unconfigured = new AppStore(config({ api: null }));
    await expect(unconfigured.state("1", "sandbox")).rejects.toMatchObject({
      reason: "not_configured",
    });
  });
});
