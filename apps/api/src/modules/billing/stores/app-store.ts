import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { X509Certificate } from "node:crypto";
import type { ProviderEventKind } from "@adclub/domain";
import { z } from "zod";
import type { AppleEnvironment, AppleStoreConfig } from "../../../config";
import { APPLE_ROOT_CA_G3_PEM } from "./apple-root-ca";
import { signEs256Jwt, StoreSignatureError, trustedRoots, verifyAppleJws } from "./signatures";
import {
  accountIdOf,
  stateEvents,
  StorePurchaseRefusedError,
  StoreUnavailableError,
  wordEvent,
  type StorePurchaseFacts,
  type StoreWord,
} from "./store-word";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The local chain of development and tests (`scripts/store-test-certs.mjs`). */
export const STORE_FIXTURES = resolve(__dirname, "..", "..", "..", "..", "fixtures", "stores");

/**
 * **The one table of App Store Server Notifications V2 → our events**
 * (TASK-041; ARCHITECTURE 9.4.1 rule 3, 4.98). Names and subtypes as Apple
 * documents them (checked 20.11.2026):
 * https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 * https://developer.apple.com/documentation/appstoreservernotifications/subtype
 *
 * The key is `TYPE` or `TYPE/SUBTYPE`; the subtype's own row wins over the
 * type's. `ignored` — understood and changes nothing (kept in
 * `store_notification`); a name absent here is «unknown» — kept, changes
 * nothing. The moments come with the notification: the paid term's end is
 * the transaction's `expiresDate`, the grace's end — the renewal info's
 * `gracePeriodExpiresDate` (never computed here, 9.4.1 rule 4).
 */
export const appleNotificationEvents: Readonly<
  Partial<Record<string, ProviderEventKind | "ignored">>
> = {
  // A first purchase, or a purchase again after the subscription ended.
  "SUBSCRIBED/INITIAL_BUY": "started",
  "SUBSCRIBED/RESUBSCRIBE": "started",
  // A renewal; BILLING_RECOVERY — paid after a failure (out of the grace or the retry).
  DID_RENEW: "renewed",
  "DID_RENEW/BILLING_RECOVERY": "renewed",
  // The charge failed: with GRACE_PERIOD access stays to the grace's end;
  // without it the subscription is in billing retry — access is stopped,
  // the store may still recover it (our `suspended`).
  "DID_FAIL_TO_RENEW/GRACE_PERIOD": "grace_started",
  DID_FAIL_TO_RENEW: "suspended",
  // The grace ended unpaid; Apple keeps retrying (up to 60 days) — stopped, recoverable.
  GRACE_PERIOD_EXPIRED: "suspended",
  // Over: switched off and the term ended, retries ended, a price rise refused, the product gone.
  EXPIRED: "expired",
  "EXPIRED/VOLUNTARY": "expired",
  "EXPIRED/BILLING_RETRY": "expired",
  "EXPIRED/PRICE_INCREASE": "expired",
  "EXPIRED/PRODUCT_NOT_FOR_SALE": "expired",
  // Renewal switched off (the term runs to its end) and back on.
  "DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED": "cancelled",
  "DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_ENABLED": "cancel_withdrawn",
  // Money returned: access ends now. SEATS — a part of a multiseat purchase, access stays.
  REFUND: "refunded",
  "REFUND/SEATS": "ignored",
  // Family Sharing (or a group) withdrew the purchase: access ends now.
  REVOKE: "revoked",
  // The developer moved the renewal date: a longer paid term.
  RENEWAL_EXTENDED: "renewed",
  // An upgrade takes effect at once with a new term; a downgrade — at the next renewal.
  "DID_CHANGE_RENEWAL_PREF/UPGRADE": "renewed",
  "OFFER_REDEEMED/UPGRADE": "renewed",
  DID_CHANGE_RENEWAL_PREF: "ignored",
  OFFER_REDEEMED: "ignored",
  // Nothing to do for a subscription of the club.
  CONSUMPTION_REQUEST: "ignored",
  REFUND_DECLINED: "ignored",
  // A refund reversed: the reconciliation of the purchase brings the store's state back.
  REFUND_REVERSED: "ignored",
  PRICE_INCREASE: "ignored",
  RENEWAL_EXTENSION: "ignored",
  TEST: "ignored",
  ONE_TIME_CHARGE: "ignored",
  EXTERNAL_PURCHASE_TOKEN: "ignored",
  METADATA_UPDATE: "ignored",
  MIGRATION: "ignored",
  PRICE_CHANGE: "ignored",
  RESCIND_CONSENT: "ignored",
  UNCLAIM_SEATS: "ignored",
};

/** The row of the table for a notification, or `null` — a name we don't know. */
export function appleNotificationEvent(
  type: string,
  subtype: string | null,
): ProviderEventKind | "ignored" | null {
  return (
    (subtype ? appleNotificationEvents[`${type}/${subtype}`] : undefined) ??
    appleNotificationEvents[type] ??
    null
  );
}

/**
 * **The status of the App Store Server API → our events** (Get All
 * Subscription Statuses, `status`; checked 20.11.2026:
 * https://developer.apple.com/documentation/appstoreserverapi/status).
 * A state is said as a paid term and, beside it, what else holds: renewal
 * off, a grace, a hold. Refunded or revoked (5) and expired (2) end it.
 */
export const appleStatusEvents: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  1: "active — renewed to expiresDate; cancelled if autoRenewStatus is 0, else cancel_withdrawn",
  2: "expired — refunded if the transaction carries a revocationDate",
  3: "billing retry — renewed to expiresDate, then suspended",
  4: "grace — renewed to expiresDate, then grace_started to gracePeriodExpiresDate",
  5: "revoked — revoked",
};

const ms = z.number().int().nonnegative();

const transactionSchema = z.object({
  transactionId: z.string().min(1).max(64),
  originalTransactionId: z.string().min(1).max(64),
  bundleId: z.string().min(1),
  productId: z.string().min(1).max(200),
  type: z.string(),
  purchaseDate: ms.optional(),
  expiresDate: ms.optional(),
  signedDate: ms,
  environment: z.string(),
  appAccountToken: z.string().optional(),
  revocationDate: ms.optional(),
});

export type AppleTransaction = z.infer<typeof transactionSchema>;

const renewalSchema = z.object({
  originalTransactionId: z.string().min(1).max(64),
  autoRenewStatus: z.number().int().optional(),
  gracePeriodExpiresDate: ms.optional(),
  isInBillingRetryPeriod: z.boolean().optional(),
  signedDate: ms,
  environment: z.string(),
});

const notificationSchema = z.object({
  notificationType: z.string().min(1).max(64),
  subtype: z.string().min(1).max(64).optional(),
  notificationUUID: z.string().min(1).max(64),
  signedDate: ms,
  version: z.string().optional(),
  data: z
    .object({
      bundleId: z.string(),
      environment: z.string(),
      appAppleId: z.number().int().optional(),
      signedTransactionInfo: z.string().optional(),
      signedRenewalInfo: z.string().optional(),
      status: z.number().int().optional(),
    })
    .optional(),
});

const statusResponseSchema = z.object({
  environment: z.string(),
  bundleId: z.string(),
  data: z.array(
    z.object({
      lastTransactions: z.array(
        z.object({
          originalTransactionId: z.string(),
          status: z.number().int(),
          signedTransactionInfo: z.string(),
          signedRenewalInfo: z.string().optional(),
        }),
      ),
    }),
  ),
});

/** A notification of the App Store, read: its word (or why none), and its own name. */
export interface AppleNotification {
  notificationId: string;
  /** `TYPE` or `TYPE/SUBTYPE`. */
  name: string;
  eventAt: Date;
  /** `null` — nothing to apply (ignored, unknown, no subscription in it). */
  word: StoreWord | null;
  result: "events" | "ignored" | "unknown";
}

function environmentOf(value: string): AppleEnvironment | null {
  const lower = value.toLowerCase();
  return lower === "production" || lower === "sandbox" ? lower : null;
}

/** How long one call of the App Store Server API may take. */
const API_TIMEOUT_MS = 10_000;

/**
 * The App Store (TASK-041; ARCHITECTURE 9.4.1, 4.98): App Store Server
 * Notifications V2 and the App Store Server API on plain `fetch` and
 * `node:crypto` — no SDK, no aggregator.
 *
 * **Nothing here has ever reached Apple.** There are no App Store Connect
 * accounts yet: this file is written from Apple's documentation and
 * exercised against a local server and a locally made chain of certificates
 * (`apps/api/fixtures/stores`) — the live check in the sandbox is a task of
 * its own.
 */
export class AppStore {
  private readonly roots: X509Certificate[];

  constructor(
    readonly config: AppleStoreConfig,
    private readonly fetch: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {
    const pems = [APPLE_ROOT_CA_G3_PEM];
    if (config.devTrust)
      pems.push(readFileSync(resolve(STORE_FIXTURES, "apple-dev-root.pem"), "utf8"));
    this.roots = trustedRoots(pems);
  }

  /** Can it read what Apple signs (always, with a bundle); can it ask Apple (only with the API key). */
  get canReceive(): boolean {
    return this.config.environments.length > 0;
  }

  private verify(jws: string): Record<string, unknown> {
    try {
      return verifyAppleJws(jws, this.roots, new Date(this.now()));
    } catch (error) {
      if (error instanceof StoreSignatureError) {
        throw new StorePurchaseRefusedError(error.message, "signature");
      }
      throw error;
    }
  }

  private environment(value: string): AppleEnvironment {
    const environment = environmentOf(value);
    if (!environment || !this.config.environments.includes(environment)) {
      throw new StorePurchaseRefusedError(
        `The ${String(environment ?? "unknown")} environment is not accepted here`,
        "environment",
      );
    }
    return environment;
  }

  private bundle(bundleId: string): void {
    if (bundleId !== this.config.bundleId) {
      throw new StorePurchaseRefusedError("Another app's purchase", "bundle");
    }
  }

  /** A signed transaction, checked: Apple's chain, our app, an accepted environment, a subscription. */
  readTransaction(jws: string): AppleTransaction & { environmentValue: AppleEnvironment } {
    const parsed = transactionSchema.safeParse(this.verify(jws));
    if (!parsed.success) throw new StorePurchaseRefusedError("Not a transaction", "malformed");
    this.bundle(parsed.data.bundleId);
    const environmentValue = this.environment(parsed.data.environment);
    if (parsed.data.type !== "Auto-Renewable Subscription" || !parsed.data.expiresDate) {
      throw new StorePurchaseRefusedError("Not an auto-renewable subscription", "not_subscription");
    }
    return { ...parsed.data, environmentValue };
  }

  private facts(
    transaction: AppleTransaction,
    environment: AppleEnvironment,
    word: string,
    wordAt: Date,
  ): StorePurchaseFacts {
    return {
      platform: "ios",
      providerRef: `apple:${transaction.originalTransactionId}`,
      environment,
      productId: transaction.productId,
      accountId: accountIdOf(transaction.appAccountToken),
      originalTransactionId: transaction.originalTransactionId,
      purchaseToken: null,
      word,
      wordAt,
    };
  }

  /**
   * A notification (`signedPayload`), checked whole before anything of it is
   * used: the chain to Apple's root, our bundle, an accepted environment,
   * our app's Apple ID in production. Refuses what is not ours.
   */
  readNotification(signedPayload: string): AppleNotification {
    const parsed = notificationSchema.safeParse(this.verify(signedPayload));
    if (!parsed.success) throw new StorePurchaseRefusedError("Not a notification", "malformed");
    const notification = parsed.data;
    const name = notification.subtype
      ? `${notification.notificationType}/${notification.subtype}`
      : notification.notificationType;
    const eventAt = new Date(notification.signedDate);
    const base = { notificationId: notification.notificationUUID, name, eventAt };
    const data = notification.data;
    if (data) {
      this.bundle(data.bundleId);
      const environment = this.environment(data.environment);
      if (
        environment === "production" &&
        this.config.appAppleId !== null &&
        data.appAppleId !== undefined &&
        data.appAppleId !== this.config.appAppleId
      ) {
        throw new StorePurchaseRefusedError("Another app's notification", "bundle");
      }
    }
    const kind = appleNotificationEvent(
      notification.notificationType,
      notification.subtype ?? null,
    );
    if (kind === null) return { ...base, word: null, result: "unknown" };
    if (kind === "ignored" || !data?.signedTransactionInfo) {
      return { ...base, word: null, result: "ignored" };
    }
    const transaction = this.readTransaction(data.signedTransactionInfo);
    const renewal = data.signedRenewalInfo ? this.readRenewal(data.signedRenewalInfo) : null;
    const facts = this.facts(transaction, this.environment(data.environment), name, eventAt);
    const periodEnd = transaction.expiresDate ? new Date(transaction.expiresDate) : null;
    const graceUntil =
      kind === "grace_started" && renewal?.gracePeriodExpiresDate
        ? new Date(renewal.gracePeriodExpiresDate)
        : null;
    if (kind === "grace_started" && !graceUntil) {
      // A grace without its end can't be said; the reconciliation asks the API.
      return { ...base, word: { facts, events: [] }, result: "ignored" };
    }
    return {
      ...base,
      result: "events",
      word: {
        facts,
        events: [
          wordEvent(facts, {
            id: `apple:${notification.notificationUUID}`,
            kind,
            eventAt,
            periodEnd: kind === "started" || kind === "renewed" ? periodEnd : null,
            graceUntil,
          }),
        ],
      },
    };
  }

  private readRenewal(jws: string): z.infer<typeof renewalSchema> {
    const parsed = renewalSchema.safeParse(this.verify(jws));
    if (!parsed.success) throw new StorePurchaseRefusedError("Not a renewal info", "malformed");
    this.environment(parsed.data.environment);
    return parsed.data;
  }

  /** The token of one call of the App Store Server API (ES256, at most an hour; we use 10 minutes). */
  private bearer(): string {
    const api = this.config.api;
    if (!api)
      throw new StoreUnavailableError(
        "The App Store Server API is not configured",
        "not_configured",
      );
    const nowS = Math.floor(this.now() / 1000);
    return signEs256Jwt(
      { kid: api.keyId, typ: "JWT" },
      {
        iss: api.issuerId,
        iat: nowS,
        exp: nowS + 600,
        aud: "appstoreconnect-v1",
        bid: this.config.bundleId,
      },
      api.privateKey,
    );
  }

  /**
   * The purchase's state now (Get All Subscription Statuses), said in our
   * words. `null` — Apple doesn't know the transaction (404).
   */
  async state(
    originalTransactionId: string,
    environment: AppleEnvironment,
  ): Promise<StoreWord | null> {
    const url = `${this.config.apiUrls[environment]}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.bearer()}`, accept: "application/json" },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw error;
      const timeout = error instanceof Error && error.name === "TimeoutError";
      throw new StoreUnavailableError(
        timeout
          ? "The App Store Server API did not answer in time"
          : "The App Store Server API could not be reached",
        timeout ? "timeout" : "network",
      );
    }
    if (response.status === 404) return null;
    if (response.status === 401) {
      throw new StoreUnavailableError("The App Store Server API refused our key", "auth");
    }
    if (!response.ok) {
      throw new StoreUnavailableError(
        `The App Store Server API answered ${String(response.status)}`,
        `http_${String(response.status)}`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new StoreUnavailableError("The App Store Server API answered not JSON", "malformed");
    }
    const parsed = statusResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new StoreUnavailableError(
        "The App Store Server API answered something else",
        "malformed",
      );
    }
    this.bundle(parsed.data.bundleId);
    const item = parsed.data.data
      .flatMap((group) => group.lastTransactions)
      .find((last) => last.originalTransactionId === originalTransactionId);
    if (!item) return null;
    const transaction = this.readTransaction(item.signedTransactionInfo);
    const renewal = item.signedRenewalInfo ? this.readRenewal(item.signedRenewalInfo) : null;
    const wordAt = new Date(Math.max(transaction.signedDate, renewal?.signedDate ?? 0));
    const facts = this.facts(
      transaction,
      transaction.environmentValue,
      `status:${String(item.status)}`,
      wordAt,
    );
    const periodEnd = new Date(transaction.expiresDate!);
    switch (item.status) {
      case 1:
        return {
          facts,
          events: stateEvents(facts, [
            { kind: "renewed", periodEnd },
            { kind: renewal?.autoRenewStatus === 0 ? "cancelled" : "cancel_withdrawn", periodEnd },
          ]),
        };
      case 2:
        return {
          facts,
          events: stateEvents(facts, [
            { kind: transaction.revocationDate ? "refunded" : "expired", periodEnd },
          ]),
        };
      case 3:
        return {
          facts,
          events: stateEvents(facts, [
            { kind: "renewed", periodEnd },
            { kind: "suspended", periodEnd },
          ]),
        };
      case 4: {
        const graceUntil = renewal?.gracePeriodExpiresDate
          ? new Date(renewal.gracePeriodExpiresDate)
          : null;
        return {
          facts,
          events: stateEvents(facts, [
            { kind: "renewed", periodEnd },
            ...(graceUntil ? [{ kind: "grace_started" as const, graceUntil }] : []),
          ]),
        };
      }
      case 5:
        return { facts, events: stateEvents(facts, [{ kind: "revoked", periodEnd }]) };
      default:
        return { facts, events: [] };
    }
  }
}
