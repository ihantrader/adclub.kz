import type { ProviderEventKind } from "@adclub/domain";
import type { NormalizedProviderEvent } from "../subscription-provider";
import type { StoreEnvironment, StorePlatform } from "../schema";

/**
 * What a store said about one purchase (TASK-041, ARCHITECTURE 4.98): the
 * facts of the purchase (ours to keep in `store_purchase`) and the events in
 * our words (`billing_event`). A notification gives one event or none; the
 * state the store's API reports gives one or two (a paid term and, beside
 * it, renewal switched off, a grace, a hold).
 */
export interface StorePurchaseFacts {
  platform: StorePlatform;
  /** Our reference of the purchase: `apple:<originalTransactionId>`, `google:<sha-256 of the token>`. */
  providerRef: string;
  environment: StoreEnvironment;
  productId: string;
  /** The account the store names (`appAccountToken`, `obfuscatedExternalAccountId`); `null` — none. */
  accountId: string | null;
  /** Apple: the original transaction id; Google: the purchase token (kept, never shown). */
  originalTransactionId: string | null;
  purchaseToken: string | null;
  /** The store's own name of what it said (`DID_RENEW`, `SUBSCRIPTION_STATE_ACTIVE`…). */
  word: string;
  wordAt: Date;
}

export interface StoreWord {
  facts: StorePurchaseFacts;
  events: NormalizedProviderEvent[];
}

/** A store's answer the caller can't act on: the store couldn't be reached, or refused us. */
export class StoreUnavailableError extends Error {
  constructor(
    message: string,
    /** `not_configured`, `timeout`, `network`, `http_<status>`, `auth`, `malformed`. */
    readonly reason: string,
  ) {
    super(message);
  }
}

/** The purchase is not one we take: forged, another app, another environment, not a subscription. */
export class StorePurchaseRefusedError extends Error {
  constructor(
    message: string,
    /** `signature`, `bundle`, `environment`, `not_subscription`, `malformed`, `not_found`. */
    readonly reason: string,
  ) {
    super(message);
  }
}

/** A UUID the store names as the account, or `null` — anything else names nobody of ours. */
export function accountIdOf(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

/** One event of a word, with the moments it needs. */
export function wordEvent(
  facts: StorePurchaseFacts,
  input: {
    id: string;
    kind: ProviderEventKind;
    eventAt: Date;
    periodEnd?: Date | null;
    graceUntil?: Date | null;
  },
): NormalizedProviderEvent {
  return {
    providerEventId: input.id,
    kind: input.kind,
    providerRef: facts.providerRef,
    accountId: facts.accountId,
    eventAt: input.eventAt,
    periodEnd: input.periodEnd ?? null,
    graceUntil: input.graceUntil ?? null,
    platform: facts.platform,
    productId: facts.productId,
  };
}

/**
 * The events of a state the store's API reports: what to say, in order. The
 * id of each is made of the purchase, the kind and the moment it is about,
 * so the same state asked twice (a repeated `sync`, a reconciliation) is the
 * same event — a duplicate, not a second row. Two events of one state are a
 * millisecond apart: they are applied in this order.
 */
export function stateEvents(
  facts: StorePurchaseFacts,
  steps: { kind: ProviderEventKind; periodEnd?: Date | null; graceUntil?: Date | null }[],
): NormalizedProviderEvent[] {
  return steps.map((step, index) => {
    const moment = step.graceUntil ?? step.periodEnd ?? null;
    return wordEvent(facts, {
      id: `${facts.providerRef}:state:${step.kind}:${moment ? String(moment.getTime()) : "-"}`,
      kind: step.kind,
      eventAt: new Date(facts.wordAt.getTime() + index),
      periodEnd: step.periodEnd ?? null,
      graceUntil: step.graceUntil ?? null,
    });
  });
}
