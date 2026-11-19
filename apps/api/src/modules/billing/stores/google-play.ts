import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderEventKind } from "@adclub/domain";
import { z } from "zod";
import type { GoogleStoreConfig } from "../../../config";
import { STORE_FIXTURES, type FetchLike } from "./app-store";
import { signRs256Jwt, StoreSignatureError, verifyRs256Jwt } from "./signatures";
import {
  accountIdOf,
  stateEvents,
  StorePurchaseRefusedError,
  StoreUnavailableError,
  wordEvent,
  type StorePurchaseFacts,
  type StoreWord,
} from "./store-word";

/**
 * **The one table of Google Play Real-time Developer Notifications → what
 * we do** (TASK-041; ARCHITECTURE 9.4.1 rule 3, 4.98). The codes of
 * `subscriptionNotification.notificationType` as Google documents them
 * (checked 20.11.2026): https://developer.android.com/google/play/billing/rtdn-reference
 *
 * A notification of Google carries only the purchase token: what changed is
 * read from the Play Developer API (`state`, then `googleStateEvents`). So a
 * row is `state` — ask the API and say its state — or `ignored`. A code
 * absent here is «unknown»: kept, changes nothing.
 */
export const googleNotificationTypes: Readonly<
  Partial<Record<number, { name: string; action: "state" | "ignored" }>>
> = {
  1: { name: "SUBSCRIPTION_RECOVERED", action: "state" },
  2: { name: "SUBSCRIPTION_RENEWED", action: "state" },
  3: { name: "SUBSCRIPTION_CANCELED", action: "state" },
  4: { name: "SUBSCRIPTION_PURCHASED", action: "state" },
  5: { name: "SUBSCRIPTION_ON_HOLD", action: "state" },
  6: { name: "SUBSCRIPTION_IN_GRACE_PERIOD", action: "state" },
  7: { name: "SUBSCRIPTION_RESTARTED", action: "state" },
  // Deprecated by Google; price changes are 19.
  8: { name: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED", action: "ignored" },
  9: { name: "SUBSCRIPTION_DEFERRED", action: "state" },
  10: { name: "SUBSCRIPTION_PAUSED", action: "state" },
  11: { name: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED", action: "state" },
  12: { name: "SUBSCRIPTION_REVOKED", action: "state" },
  13: { name: "SUBSCRIPTION_EXPIRED", action: "state" },
  17: { name: "SUBSCRIPTION_ITEMS_CHANGED", action: "state" },
  18: { name: "SUBSCRIPTION_CANCELLATION_SCHEDULED", action: "state" },
  19: { name: "SUBSCRIPTION_PRICE_CHANGE_UPDATED", action: "ignored" },
  20: { name: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED", action: "ignored" },
  22: { name: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED", action: "ignored" },
};

/**
 * **`subscriptionState` of `purchases.subscriptionsv2` → our events**
 * (checked 20.11.2026:
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#SubscriptionState).
 * The paid term's end is the line item's `expiryTime`. In the grace period
 * the line item's `expiryTime` is taken as the grace's end
 * **[to check in the sandbox]**: the documentation says only «all items are
 * in grace period». A pending or cancelled-before-paid purchase says nothing.
 */
export const googleStateEvents: Readonly<
  Partial<
    Record<
      string,
      (end: Date) => { kind: ProviderEventKind; periodEnd?: Date; graceUntil?: Date }[]
    >
  >
> = {
  SUBSCRIPTION_STATE_ACTIVE: (end) => [
    { kind: "renewed", periodEnd: end },
    { kind: "cancel_withdrawn", periodEnd: end },
  ],
  SUBSCRIPTION_STATE_CANCELED: (end) => [
    { kind: "renewed", periodEnd: end },
    { kind: "cancelled", periodEnd: end },
  ],
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: (end) => [{ kind: "grace_started", graceUntil: end }],
  SUBSCRIPTION_STATE_ON_HOLD: (end) => [{ kind: "suspended", periodEnd: end }],
  SUBSCRIPTION_STATE_PAUSED: (end) => [{ kind: "suspended", periodEnd: end }],
  SUBSCRIPTION_STATE_EXPIRED: (end) => [{ kind: "expired", periodEnd: end }],
  SUBSCRIPTION_STATE_PENDING: () => [],
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: () => [],
  SUBSCRIPTION_STATE_UNSPECIFIED: () => [],
};

/** Our reference of a Play purchase: the token is long and not to be shown, its hash is. */
export function googleRef(purchaseToken: string): string {
  return `google:${createHash("sha256").update(purchaseToken).digest("hex")}`;
}

const developerNotificationSchema = z.object({
  version: z.string().optional(),
  packageName: z.string(),
  eventTimeMillis: z.union([z.string().regex(/^\d+$/), z.number().int()]),
  subscriptionNotification: z
    .object({
      version: z.string().optional(),
      notificationType: z.number().int(),
      purchaseToken: z.string().min(1).max(4096),
    })
    .optional(),
  voidedPurchaseNotification: z
    .object({
      purchaseToken: z.string().min(1).max(4096),
      orderId: z.string().optional(),
      productType: z.number().int(),
      refundType: z.number().int().optional(),
    })
    .optional(),
  testNotification: z.object({ version: z.string().optional() }).optional(),
});

const pushSchema = z.object({
  message: z.object({
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
    messageId: z.string().min(1).max(200),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const subscriptionV2Schema = z.object({
  subscriptionState: z.string(),
  lineItems: z
    .array(z.object({ productId: z.string().min(1), expiryTime: z.string().optional() }))
    .min(1),
  acknowledgementState: z.string().optional(),
  externalAccountIdentifiers: z
    .object({ obfuscatedExternalAccountId: z.string().optional() })
    .optional(),
  testPurchase: z.object({}).passthrough().optional(),
  linkedPurchaseToken: z.string().optional(),
});

const certsSchema = z.object({
  keys: z.array(
    z
      .object({ kid: z.string(), kty: z.literal("RSA"), n: z.string(), e: z.string() })
      .passthrough(),
  ),
});

const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/** A Pub/Sub delivery of Google Play, read. */
export interface GoogleNotification {
  notificationId: string;
  /** `4:SUBSCRIPTION_PURCHASED`, `voided`, `test`, `unknown:<code>`. */
  name: string;
  eventAt: Date;
  /** What to do: read the state of `purchaseToken`, end it now (a refund), or nothing. */
  action: "state" | "refunded" | "ignored" | "unknown";
  purchaseToken: string | null;
}

const API_TIMEOUT_MS = 10_000;
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
/** Google publishes its keys for about a day; we keep them an hour. */
const CERTS_TTL_MS = 3_600_000;

/** The account and the moment of a notification, without the token. */
export interface GooglePurchaseState {
  word: StoreWord;
  acknowledged: boolean;
  linkedPurchaseToken: string | null;
}

/**
 * Google Play (TASK-041; ARCHITECTURE 9.4.1, 4.98): Real-time Developer
 * Notifications through a Pub/Sub push subscription, and the Play Developer
 * API (`purchases.subscriptionsv2.get`, `purchases.subscriptions.acknowledge`)
 * with an OAuth2 token of the service account — plain `fetch` and
 * `node:crypto`, no Google SDK.
 *
 * **Nothing here has ever reached Google.** No Play Console account yet: the
 * file is written from Google's documentation and exercised against a local
 * server; the live check is a task of its own.
 */
export class GooglePlay {
  private accessToken: { value: string; renewAt: number } | null = null;
  private certs: { keys: Map<string, KeyObject>; until: number } | null = null;
  private readonly devKey: KeyObject | null;

  constructor(
    readonly config: GoogleStoreConfig,
    private readonly fetch: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {
    this.devKey = config.devTrust
      ? createPublicKey(
          createPrivateKey(readFileSync(resolve(STORE_FIXTURES, "google-dev-oidc.key"), "utf8")),
        )
      : null;
  }

  get canReceive(): boolean {
    return this.config.pubsub !== null;
  }

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    } catch (error) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      throw new StoreUnavailableError(
        timeout ? `${what} did not answer in time` : `${what} could not be reached`,
        timeout ? "timeout" : "network",
      );
    }
  }

  /** Google's keys of OIDC tokens; the development key beside them in development and tests. */
  private async keys(): Promise<Map<string, KeyObject>> {
    if (this.certs && this.certs.until > this.now()) return this.certs.keys;
    const response = await this.call(this.config.certsUrl, { method: "GET" }, "Google's keys");
    if (!response.ok) {
      throw new StoreUnavailableError(
        `Google's keys answered ${String(response.status)}`,
        `http_${String(response.status)}`,
      );
    }
    const parsed = certsSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new StoreUnavailableError("Google's keys are not JWKS", "malformed");
    const keys = new Map<string, KeyObject>();
    for (const jwk of parsed.data.keys) {
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // a key we can't read is a key nobody signs with for us
      }
    }
    this.certs = { keys, until: this.now() + CERTS_TTL_MS };
    return keys;
  }

  /**
   * The push's OIDC token, checked before the body is read: the signature
   * by Google's key (in development and tests also the local key, kid
   * `adclub-dev`), the audience and the sender of our subscription.
   */
  async verifyPush(authorization: string | undefined): Promise<void> {
    const pubsub = this.config.pubsub;
    if (!pubsub)
      throw new StoreUnavailableError(
        "Google Play notifications are not configured",
        "not_configured",
      );
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization ?? "")?.[1];
    if (!token || token.split(".").length !== 3) {
      throw new StorePurchaseRefusedError("No token", "signature");
    }
    const devKey = this.devKey;
    const viaDevKey = devKey !== null && token.length > 0 && headerKid(token) === DEV_OIDC_KID;
    const keys = viaDevKey ? null : await this.keys();
    let claims: Record<string, unknown>;
    try {
      claims = verifyRs256Jwt(
        token,
        (kid) => (viaDevKey ? (kid === DEV_OIDC_KID ? devKey : undefined) : keys!.get(kid)),
        Math.floor(this.now() / 1000),
      );
    } catch (error) {
      if (error instanceof StoreSignatureError) {
        throw new StorePurchaseRefusedError(error.message, "signature");
      }
      throw error;
    }
    const issuerOk =
      claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (
      !issuerOk ||
      claims.aud !== pubsub.audience ||
      claims.email !== pubsub.serviceAccount ||
      claims.email_verified !== true
    ) {
      throw new StorePurchaseRefusedError("The token is not of our subscription", "signature");
    }
  }

  /** A Pub/Sub push body (after its token was checked). */
  readPush(body: unknown): GoogleNotification {
    const push = pushSchema.safeParse(body);
    if (!push.success) throw new StorePurchaseRefusedError("Not a Pub/Sub push", "malformed");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(push.data.message.data, "base64").toString("utf8"));
    } catch {
      throw new StorePurchaseRefusedError("The message is not JSON", "malformed");
    }
    const parsed = developerNotificationSchema.safeParse(decoded);
    if (!parsed.success)
      throw new StorePurchaseRefusedError("Not a developer notification", "malformed");
    const notification = parsed.data;
    if (notification.packageName !== this.config.packageName) {
      throw new StorePurchaseRefusedError("Another app's notification", "bundle");
    }
    const eventAt = new Date(Number(notification.eventTimeMillis));
    const base = { notificationId: push.data.message.messageId, eventAt };
    if (notification.subscriptionNotification) {
      const code = notification.subscriptionNotification.notificationType;
      const row = googleNotificationTypes[code];
      return {
        ...base,
        name: row ? `${String(code)}:${row.name}` : `unknown:${String(code)}`,
        action: row ? row.action : "unknown",
        purchaseToken: notification.subscriptionNotification.purchaseToken,
      };
    }
    if (notification.voidedPurchaseNotification) {
      const voided = notification.voidedPurchaseNotification;
      // A subscription refunded in full ends now; a partial refund or a one-time product — nothing.
      const ends = voided.productType === 1 && (voided.refundType ?? 1) === 1;
      return {
        ...base,
        name: `voided:${String(voided.productType)}:${String(voided.refundType ?? 1)}`,
        action: ends ? "refunded" : "ignored",
        purchaseToken: voided.purchaseToken,
      };
    }
    if (notification.testNotification) {
      return { ...base, name: "test", action: "ignored", purchaseToken: null };
    }
    return { ...base, name: "unknown", action: "unknown", purchaseToken: null };
  }

  private async bearer(): Promise<string> {
    const api = this.config.api;
    if (!api)
      throw new StoreUnavailableError("The Play Developer API is not configured", "not_configured");
    if (this.accessToken && this.accessToken.renewAt > this.now()) return this.accessToken.value;
    const nowS = Math.floor(this.now() / 1000);
    const assertion = signRs256Jwt(
      {},
      { iss: api.clientEmail, scope: SCOPE, aud: api.tokenUrl, iat: nowS, exp: nowS + 3600 },
      api.privateKey,
    );
    const response = await this.call(
      api.tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
      "Google's token endpoint",
    );
    const parsed = tokenAnswerSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) {
      throw new StoreUnavailableError(
        `Google's token endpoint answered ${String(response.status)}`,
        "auth",
      );
    }
    this.accessToken = {
      value: parsed.data.access_token,
      renewAt: this.now() + Math.max(0, parsed.data.expires_in * 1000 - 300_000),
    };
    return parsed.data.access_token;
  }

  private purchaseUrl(path: string): string {
    return `${this.config.apiUrl}/androidpublisher/v3/applications/${encodeURIComponent(this.config.packageName)}/purchases/${path}`;
  }

  /** The purchase's state now (`purchases.subscriptionsv2.get`); `null` — Google doesn't know the token. */
  async state(
    purchaseToken: string,
    productHint: string | null = null,
  ): Promise<GooglePurchaseState | null> {
    const response = await this.call(
      this.purchaseUrl(`subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`),
      {
        method: "GET",
        headers: { authorization: `Bearer ${await this.bearer()}`, accept: "application/json" },
      },
      "The Play Developer API",
    );
    if (response.status === 404 || response.status === 410) return null;
    if (response.status === 401 || response.status === 403) {
      this.accessToken = null;
      throw new StoreUnavailableError("The Play Developer API refused our service account", "auth");
    }
    if (response.status === 400) {
      throw new StorePurchaseRefusedError(
        "The Play Developer API does not take this token",
        "not_found",
      );
    }
    if (!response.ok) {
      throw new StoreUnavailableError(
        `The Play Developer API answered ${String(response.status)}`,
        `http_${String(response.status)}`,
      );
    }
    const parsed = subscriptionV2Schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new StoreUnavailableError(
        "The Play Developer API answered something else",
        "malformed",
      );
    }
    const purchase = parsed.data;
    const line =
      purchase.lineItems.find((item) => item.productId === productHint) ?? purchase.lineItems[0]!;
    const wordAt = new Date(this.now());
    const facts: StorePurchaseFacts = {
      platform: "android",
      providerRef: googleRef(purchaseToken),
      environment: purchase.testPurchase ? "sandbox" : "production",
      productId: line.productId,
      accountId: accountIdOf(purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId),
      originalTransactionId: null,
      purchaseToken,
      word: purchase.subscriptionState,
      wordAt,
    };
    const end = line.expiryTime ? new Date(line.expiryTime) : null;
    const say = googleStateEvents[purchase.subscriptionState];
    const steps = say && end && !Number.isNaN(end.getTime()) ? say(end) : [];
    return {
      word: { facts, events: stateEvents(facts, steps) },
      acknowledged: purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
    };
  }

  /** `purchases.subscriptions.acknowledge`: without it Google refunds the purchase in three days. */
  async acknowledge(productId: string, purchaseToken: string): Promise<void> {
    const response = await this.call(
      this.purchaseUrl(
        `subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.bearer()}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
      "The Play Developer API",
    );
    if (!response.ok) {
      throw new StoreUnavailableError(
        `Acknowledging answered ${String(response.status)}`,
        `http_${String(response.status)}`,
      );
    }
  }

  /** A refund of the whole subscription, said as an event of the purchase. */
  refundWord(
    notification: GoogleNotification,
    known: { productId: string; environment: "production" | "sandbox" } | null,
  ): StoreWord | null {
    if (!notification.purchaseToken || !known) return null;
    const facts: StorePurchaseFacts = {
      platform: "android",
      providerRef: googleRef(notification.purchaseToken),
      environment: known.environment,
      productId: known.productId,
      accountId: null,
      originalTransactionId: null,
      purchaseToken: notification.purchaseToken,
      word: notification.name,
      wordAt: notification.eventAt,
    };
    return {
      facts,
      events: [
        wordEvent(facts, {
          id: `google:${notification.notificationId}`,
          kind: "refunded",
          eventAt: notification.eventAt,
        }),
      ],
    };
  }
}

/** The `kid` of the local OIDC key of development and tests. */
export const DEV_OIDC_KID = "adclub-dev";

function headerKid(token: string): string | null {
  try {
    const header: unknown = JSON.parse(
      Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
    );
    return header &&
      typeof header === "object" &&
      typeof (header as { kid?: unknown }).kid === "string"
      ? (header as { kid: string }).kid
      : null;
  } catch {
    return null;
  }
}
