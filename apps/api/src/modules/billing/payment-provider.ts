import type { PaymentCardBrand, PaymentDeclineReason } from "@adclub/contracts";
import type { PaymentProviderName } from "./schema";

/**
 * The port of a card processor (ARCHITECTURE 9.4.2, 4.77; TASK-042): what the
 * billing module needs of Freedom Pay or CloudPayments KZ, and nothing of
 * their own words. The processor is not chosen yet (no contract, no API
 * access); the one implementation is `TestPaymentProvider`, and the real one
 * will be a second class behind this port — the rest of the module doesn't
 * change.
 *
 * **The card never passes through our server.** The person types the number
 * on the provider's own page (`beginCardBinding` gives its address); the
 * provider sends the browser back and tells us a token (a webhook, or
 * `getCardBinding`). A charge is `charge(token, amount, idempotencyKey)`.
 *
 * **Idempotency is the provider's half of «not twice for a period».** The
 * same `idempotencyKey` is the same payment: asking again after a lost
 * answer returns the first result and charges nothing more. Our half is the
 * database: one success and one open attempt per period.
 */

/** The provider cannot be reached or refuses to work (not the payer's fault). */
export class PaymentProviderUnavailableError extends Error {}

export interface BindingStart {
  /** The provider's own id of the session. */
  providerRef: string;
  /**
   * The provider's page. Absolute, or — for the test provider's page on our
   * own API — a path the cabinet resolves against the API's address.
   */
  redirectUrl: string;
}

export interface BoundCard {
  /** The provider's token for the card: a secret, sealed at once and never shown. */
  token: string;
  mask: string;
  brand: PaymentCardBrand;
  expMonth: number;
  expYear: number;
}

export type BindingLookup =
  { kind: "pending" } | { kind: "bound"; card: BoundCard } | { kind: "cancelled" };

export interface ChargeRequest {
  /** The provider's key of «this one payment»: the same key never charges twice. */
  idempotencyKey: string;
  token: string;
  /** In tenge. */
  amount: number;
  currency: "KZT";
  /** What the payment is for, as the bank statement shows it. */
  description: string;
}

/**
 * - `succeeded` — charged;
 * - `declined` — the bank refused, with the reason in our words (the payer's
 *   matter: counts as a failed day);
 * - `unavailable` — the provider could not take the request, **nothing was
 *   charged** (connection refused, an answer of «try later» before any
 *   processing); not the payer's fault, retried in an hour;
 * - `unknown` — the request may have reached the provider and the answer was
 *   lost (a timeout, a broken connection, a malformed answer); the payment is
 *   looked up by its key before anything is sent again.
 */
export type ChargeResult =
  | { kind: "succeeded"; providerPaymentId: string }
  | { kind: "declined"; reason: PaymentDeclineReason; providerPaymentId: string | null }
  | { kind: "unavailable"; detail: string }
  | { kind: "unknown"; detail: string };

/** What the provider says of a payment by its key. */
export type PaymentLookup =
  | { kind: "succeeded"; providerPaymentId: string }
  | { kind: "declined"; reason: PaymentDeclineReason; providerPaymentId: string | null }
  | { kind: "not_found" }
  | { kind: "unavailable"; detail: string };

/** A delivery of the provider's webhook, read into our words (after the signature was checked). */
export type ParsedPaymentWebhook =
  | { kind: "card_bound"; eventId: string; providerRef: string; card: BoundCard }
  | { kind: "card_cancelled"; eventId: string; providerRef: string }
  | {
      kind: "payment";
      eventId: string;
      idempotencyKey: string;
      result: "succeeded" | "declined";
      reason: PaymentDeclineReason | null;
      providerPaymentId: string | null;
    }
  | { kind: "ignored"; eventId: string };

/** A delivery that is not one: malformed, or of a kind this provider doesn't send. */
export class PaymentWebhookError extends Error {}

/**
 * The port. An abstract class, so it is its own injection token (as
 * `MessageChannel` is).
 */
export abstract class PaymentProvider {
  abstract readonly name: PaymentProviderName;

  /** Opens the provider's page for a card. `orderId` is ours (the binding's id): the provider repeats it back. */
  abstract beginCardBinding(input: {
    orderId: string;
    returnUrl: string;
    supplierName: string;
  }): Promise<BindingStart>;

  /** Asks the provider how a session stands (the return reached us, the webhook may not have). */
  abstract getCardBinding(providerRef: string): Promise<BindingLookup>;

  abstract charge(request: ChargeRequest): Promise<ChargeResult>;

  /** The payment under a key: the way to learn what became of a charge whose answer was lost. */
  abstract getPayment(idempotencyKey: string): Promise<PaymentLookup>;

  /** Forgets the card at the provider (the card was replaced, or the first charge failed). */
  abstract detachCard(token: string): Promise<void>;

  /**
   * Whether a webhook is the provider's: **checked first, over the bytes as
   * they came** — the body is not parsed before this says yes.
   */
  abstract verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): boolean;

  /** Reads a verified webhook; throws `PaymentWebhookError` for what isn't one. */
  abstract parseWebhook(rawBody: Buffer): ParsedPaymentWebhook;
}

/**
 * The words of the provider's refusals in ours — one place, so the cabinet,
 * the administrator and the journal speak the same. A real implementation
 * maps the provider's own codes into `PaymentDeclineReason` the same way.
 */
export const DECLINE_REASON_WORDS: Readonly<Record<PaymentDeclineReason, string>> = {
  insufficient_funds: "недостаточно средств",
  card_expired: "срок действия карты истёк",
  card_blocked: "карта заблокирована банком",
  invalid_card: "карта недействительна",
  do_not_honor: "банк отклонил операцию",
  declined_other: "банк отказал в списании",
};
