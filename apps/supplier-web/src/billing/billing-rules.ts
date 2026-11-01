import { isApiError } from "@adclub/api-client";
import type {
  PaymentDeclineReason,
  SupplierCharge,
  SupplierCardBinding,
  SupplierPaymentCard,
  SupplierSubscriptionResponse,
} from "@adclub/contracts";
import { formatDayMonth, zonedMomentOf, type Lang, type SupplierTextKey } from "@adclub/i18n";
import { retryMinutes } from "../errors";
import { formatAmount, TENGE } from "../offers/offer-rules";
import { keepTogether, type Translate } from "../translate";

/**
 * S-BILL-01 «Подписка» (TASK-042; SCREENS 6.8): which of its states the
 * server's answer is in, and the words of each. The server decides the
 * status (`past_due`, a billing pause…); the cabinet only reads it.
 */

/**
 * - `no_card` — «Карта не привязана»: no card and no subscription;
 * - `activating` — the card is linked and the worker is making the
 *   subscription (a few seconds);
 * - `active` — «Активна»;
 * - `past_due` — «Неуспешное списание»: the bank refused, the retries go on;
 * - `paused` — «Пауза»: the retries are over, the offers are off the showcase.
 */
export type BillingKind = "no_card" | "activating" | "active" | "past_due" | "paused";

type StateFacts = Pick<SupplierSubscriptionResponse, "subscription" | "card" | "pauses">;

export function billingKind({ subscription, card, pauses }: StateFacts): BillingKind {
  if (!subscription) return card ? "activating" : "no_card";
  if (pauses.billing || subscription.status === "suspended") return "paused";
  if (subscription.status === "past_due") return "past_due";
  return "active";
}

/** What the frame of the cabinet needs to know: the company's offers are off the showcase for want of a card (T-SUP-02). */
export interface BillingFacts {
  cardMissing: boolean;
}

export function factsOf(
  response: Pick<SupplierSubscriptionResponse, "cardRequired" | "cardLinked">,
): BillingFacts {
  return { cardMissing: response.cardRequired && !response.cardLinked };
}

/** «5 ноября» — a day in the company's time zone. */
export function dayText(iso: string, timeZone: string, lang: Lang): string {
  return keepTogether(formatDayMonth(zonedMomentOf(new Date(iso), timeZone), lang, "long"));
}

/** «12 500 ₸» — a sum with the sign after a no-break space. */
export function priceText(amount: number): string {
  return `${formatAmount(amount)}${TENGE}`;
}

export function declineKey(reason: PaymentDeclineReason): SupplierTextKey {
  return `billing.decline.${reason}`;
}

/** The words of a card's brand. */
export function brandKey(brand: SupplierPaymentCard["brand"]): SupplierTextKey {
  return `billing.brand.${brand}`;
}

/** «•••• 4242». */
export function maskText(card: Pick<SupplierPaymentCard, "mask">): string {
  return `•••• ${card.mask}`;
}

/** «12/29» — the term of a card, as it is printed on it. */
export function termText(card: Pick<SupplierPaymentCard, "expMonth" | "expYear">): string {
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

/** What S-BILL-01 says about the subscription under its state badge. */
export function stateTexts(
  data: SupplierSubscriptionResponse,
  timeZone: string,
  lang: Lang,
  t: Translate,
): string[] {
  const kind = billingKind(data);
  const subscription = data.subscription;
  switch (kind) {
    case "no_card":
      return [
        data.plan
          ? t("billing.noCard.text", { price: priceText(data.plan.price) })
          : t("billing.noCard.noPlan"),
      ];
    case "activating":
      return [t("billing.activating")];
    case "active": {
      if (!subscription) return [];
      // «Активна до … · {цена} в месяц» is the tariff in force, as «Тариф» beside
      // it; what the next charge takes (a rise announced may be due by then) is
      // said with the next charge itself (TASK-042.A).
      const current = data.plan?.price ?? subscription.amount;
      const lines = [
        t("billing.activeUntil", {
          date: dayText(subscription.periodEnd, timeZone, lang),
          price: current !== null ? priceText(current) : "—",
        }),
      ];
      if (subscription.nextChargeAt) {
        const date = dayText(subscription.nextChargeAt, timeZone, lang);
        lines.push(
          subscription.amount !== null
            ? t("billing.nextChargeAmount", { date, price: priceText(subscription.amount) })
            : t("billing.nextCharge", { date }),
        );
      }
      return lines;
    }
    case "past_due": {
      if (!subscription?.lastDecline || !subscription.graceUntil) return [];
      const failed = dayText(subscription.lastDecline.at, timeZone, lang);
      const until = dayText(subscription.graceUntil, timeZone, lang);
      return [
        subscription.nextChargeAt
          ? t("billing.pastDue", {
              failed,
              next: dayText(subscription.nextChargeAt, timeZone, lang),
              until,
            })
          : t("billing.pastDue.noRetry", { failed, until }),
        t("billing.pastDue.reason", { reason: t(declineKey(subscription.lastDecline.reason)) }),
      ];
    }
    case "paused": {
      const lines = [t("billing.pausedSince")];
      if (subscription?.amount != null) {
        lines.push(t("billing.pausedCharge", { price: priceText(subscription.amount) }));
      }
      return lines;
    }
  }
}

/** The badge of the state: its words and look. */
export function stateBadge(kind: BillingKind): {
  text: SupplierTextKey;
  tone: "success" | "warning" | "danger" | "neutral";
  icon: "circleCheck" | "alertTriangle" | "pause" | "creditCard" | "clock";
} {
  switch (kind) {
    case "active":
      return { text: "billing.state.active", tone: "success", icon: "circleCheck" };
    case "past_due":
      return { text: "billing.state.pastDue", tone: "warning", icon: "alertTriangle" };
    case "paused":
      return { text: "billing.state.paused", tone: "danger", icon: "pause" };
    case "activating":
      return { text: "billing.state.activating", tone: "neutral", icon: "clock" };
    case "no_card":
      return { text: "billing.state.noCard", tone: "neutral", icon: "creditCard" };
  }
}

/**
 * The buttons of the state: `pay` is «Оплатить сейчас» after a refusal and
 * «Оплатить» on a pause; the card is linked or changed in every state (a
 * company with a subscription just changes its card — nothing is charged).
 */
export interface BillingActions {
  link: boolean;
  change: boolean;
  pay: "payNow" | "pay" | null;
}

export function billingActions(data: SupplierSubscriptionResponse): BillingActions {
  const kind = billingKind(data);
  return {
    link: kind === "no_card",
    change: data.card !== null,
    pay: !data.actions.canPayNow ? null : kind === "paused" ? "pay" : "payNow",
  };
}

// ----------------------------------------------------------------- history

export function chargeKindKey(kind: SupplierCharge["kind"]): SupplierTextKey {
  return `billing.kind.${kind}`;
}

/** «Оплачено» / «Отказ: недостаточно средств» / «Ждём ответ платёжной системы». */
export function chargeOutcomeText(charge: SupplierCharge, t: Translate): string {
  switch (charge.outcome) {
    case "succeeded":
      return t("billing.outcome.succeeded");
    case "declined":
      return t("billing.outcome.declined", {
        reason: charge.declineReason ? t(declineKey(charge.declineReason)) : "—",
      });
    case "in_progress":
      return t("billing.outcome.inProgress");
  }
}

export function chargeTone(charge: SupplierCharge): "success" | "danger" | "neutral" {
  return charge.outcome === "succeeded"
    ? "success"
    : charge.outcome === "declined"
      ? "danger"
      : "neutral";
}

/** Adds the next page of charges to those on screen, without a repeated line. */
export function mergeCharges(
  current: readonly SupplierCharge[],
  next: readonly SupplierCharge[],
): SupplierCharge[] {
  const known = new Set(current.map((charge) => charge.id));
  return [...current, ...next.filter((charge) => !known.has(charge.id))];
}

/** The first page just read replaces the head of the list; pages loaded below it stay. */
export function replaceHead(
  current: readonly SupplierCharge[],
  first: readonly SupplierCharge[],
  pageSize: number,
): SupplierCharge[] {
  if (current.length <= pageSize) return [...first];
  const fresh = new Set(first.map((charge) => charge.id));
  return [...first, ...current.slice(pageSize).filter((charge) => !fresh.has(charge.id))];
}

// ------------------------------------------------------------------ binding

/** What the trip to the provider's page has come to, for the notice on the screen. */
export type BindingNotice =
  | { kind: "progress"; text: SupplierTextKey }
  | { kind: "done"; withDate: boolean }
  | { kind: "declined"; reason: PaymentDeclineReason | null }
  | { kind: "unavailable" }
  | { kind: "abandoned" };

const DECLINE_REASONS: readonly string[] = [
  "insufficient_funds",
  "card_expired",
  "card_blocked",
  "invalid_card",
  "do_not_honor",
  "declined_other",
];

export function isDeclineReason(value: string | null): value is PaymentDeclineReason {
  return value !== null && DECLINE_REASONS.includes(value);
}

export function bindingNotice(binding: SupplierCardBinding): BindingNotice {
  switch (binding.status) {
    case "pending":
    case "card_received":
      return { kind: "progress", text: "billing.binding.waiting" };
    case "charging":
      return { kind: "progress", text: "billing.binding.charging" };
    case "completed":
      return binding.subscriptionStatus === null
        ? { kind: "progress", text: "billing.binding.activating" }
        : { kind: "done", withDate: binding.subscriptionStatus === "active" };
    case "declined":
      return {
        kind: "declined",
        reason: isDeclineReason(binding.failure) ? binding.failure : null,
      };
    case "failed":
      return binding.failure === "provider_unavailable"
        ? { kind: "unavailable" }
        : { kind: "abandoned" };
    case "abandoned":
      return { kind: "abandoned" };
  }
}

/** The trip is over, one way or another: nothing more to ask. */
export function bindingFinished(notice: BindingNotice): boolean {
  return notice.kind !== "progress";
}

// ------------------------------------------------------------------- errors

/** Where the browser goes: the provider's page, on our API for the test one (a path). */
export function redirectTarget(redirectUrl: string, apiUrl: string): string {
  return redirectUrl.startsWith("/") ? `${apiUrl.replace(/\/+$/, "")}${redirectUrl}` : redirectUrl;
}

/** The words of what a money action of the cabinet answered with. */
export function billingErrorText(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t("common.errorText");
  switch (error.code) {
    case "SERVICE_UNAVAILABLE":
      return t("billing.error.provider");
    case "BILLING_NO_PLAN":
      return t("billing.error.noPlan");
    case "BILLING_NO_CARD":
      return t("billing.error.noCard");
    case "BILLING_NOTHING_TO_PAY":
      return t("billing.error.nothingToPay");
    case "RATE_LIMITED":
      return t("common.tooManyRequests", { minutes: retryMinutes(error) });
    case "NETWORK_ERROR":
      return t("common.offline");
    default:
      return t("common.errorText");
  }
}
