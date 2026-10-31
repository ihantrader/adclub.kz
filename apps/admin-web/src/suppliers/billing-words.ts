import type {
  AdminSupplierPauses,
  PaymentCardBrand,
  PaymentDeclineReason,
  SupplierCharge,
  SupplierChargeKind,
  SupplierPaymentCard,
  SupplierSubscriptionStatus,
} from "@adclub/contracts";
import { formatDay, formatMoment, NBSP } from "../format";

/**
 * The words of a supplier's card subscription in the admin panel (TASK-042;
 * A-SUP-03 «Подписка»). Nothing here decides anything: the status, the
 * pauses and the outcome of every charge are the server's.
 */

export const SUPPLIER_SUBSCRIPTION_TEXT: Record<SupplierSubscriptionStatus, string> = {
  active: "Активна",
  past_due: "Неуспешное списание, идут повторы",
  suspended: "Приостановлена: не оплачена",
  cancelled: "Отменена, действует до конца срока",
  expired: "Закончилась",
};

export const DECLINE_REASON_TEXT: Record<PaymentDeclineReason, string> = {
  insufficient_funds: "недостаточно средств",
  card_expired: "срок действия карты истёк",
  card_blocked: "карта заблокирована банком",
  invalid_card: "карта недействительна",
  do_not_honor: "банк отклонил операцию",
  declined_other: "банк отказал в списании",
};

export const CHARGE_KIND_TEXT: Record<SupplierChargeKind, string> = {
  first: "Первое списание при привязке карты",
  scheduled: "По расписанию",
  retry: "Повтор после отказа",
  manual: "«Оплатить сейчас»",
};

export const BRAND_TEXT: Record<PaymentCardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  other: "Карта",
};

/** «1 000 ₸» — a sum, never split between the number and the tenge. */
export function amountText(amount: number): string {
  return `${amount.toLocaleString("ru-RU")}${NBSP}₸`;
}

/** «•••• 4242 · Visa». */
export function cardLine(card: Pick<SupplierPaymentCard, "mask" | "brand">): string {
  return `•••• ${card.mask} · ${BRAND_TEXT[card.brand]}`;
}

/** «12/29» — the term as it is printed on a card. */
export function termText(card: Pick<SupplierPaymentCard, "expMonth" | "expYear">): string {
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

/** «Оплачено», «Отказ: недостаточно средств», «Ждём ответ платёжной системы». */
export function chargeOutcomeText(charge: SupplierCharge): string {
  switch (charge.outcome) {
    case "succeeded":
      return "Оплачено";
    case "declined":
      return `Отказ: ${charge.declineReason ? DECLINE_REASON_TEXT[charge.declineReason] : "причина не названа"}`;
    case "in_progress":
      return charge.retryAt
        ? `Ждём ответ платёжной системы, повтор ${formatMoment(charge.retryAt)}`
        : "Идёт списание";
  }
}

/** The two pauses side by side, as the card says them. */
export function pauseLines(pauses: AdminSupplierPauses): {
  admin: string | null;
  billing: string | null;
} {
  return {
    admin: pauses.admin
      ? `Пауза администратора${pauses.admin.note ? `: ${pauses.admin.note}` : ""}, с ${formatDay(pauses.admin.since)}`
      : null,
    billing: pauses.billing ? `Пауза по оплате: с ${formatDay(pauses.billing.since)}` : null,
  };
}
