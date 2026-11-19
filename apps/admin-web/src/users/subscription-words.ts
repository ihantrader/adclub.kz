import type {
  AdminStorePurchase,
  ClubAccessState,
  SubscriptionHistoryEntry,
  SubscriptionProviderValue,
  SubscriptionStatusValue,
} from "@adclub/contracts";
import { formatMoment } from "../format";

/** «App Store · песочница · kz.adclub.club.month» (TASK-041). */
export function storeText(store: AdminStorePurchase): string {
  return [
    store.platform === "ios" ? "App Store" : "Google Play",
    store.environment === "sandbox" ? "песочница" : null,
    store.productId,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** «DID_RENEW, 20.11.2026 14:05 · сверка 20.11.2026 15:29» — the store's own name of what it said. */
export function storeWordText(store: AdminStorePurchase): string {
  const word = store.lastWord
    ? `${store.lastWord}${store.lastWordAt ? `, ${formatMoment(store.lastWordAt)}` : ""}`
    : "нет";
  return store.lastSyncAt ? `${word} · сверка ${formatMoment(store.lastSyncAt)}` : word;
}

/**
 * The words of a subscription in the admin panel (TASK-040; A-USR-02
 * «Клубный доступ»). Nothing here decides anything: the status and the
 * access are the server's.
 */

export const SUBSCRIPTION_STATUS_TEXT: Record<SubscriptionStatusValue, string> = {
  active: "Активна",
  grace: "Льготный период стора",
  past_due: "Не оплачена, идут повторы",
  cancelled: "Отменена, действует до конца срока",
  expired_unconfirmed: "Статус не подтверждён",
  suspended: "Приостановлена провайдером",
  expired: "Закончилась",
};

export const SUBSCRIPTION_PROVIDER_TEXT: Record<SubscriptionProviderValue, string> = {
  store: "App Store / Google Play",
  card_kz: "Карта",
  test: "Тестовый провайдер",
};

export const SUBSCRIPTION_EVENT_TEXT: Record<string, string> = {
  started: "Оформлена",
  renewed: "Продлена",
  grace_started: "Проблема с оплатой, льготный период",
  payment_failed: "Не удалось списать",
  suspended: "Приостановлена",
  cancelled: "Отменено продление",
  cancel_withdrawn: "Продление включено снова",
  expired: "Закончилась",
  refunded: "Возврат денег",
  revoked: "Покупка отозвана",
  period_lapsed: "Срок прошёл без подтверждения",
  grace_lapsed: "Льготный период прошёл",
  tolerance_lapsed: "Подтверждение не пришло",
};

export const SUBSCRIPTION_BY_TEXT: Record<SubscriptionHistoryEntry["by"], string> = {
  provider: "провайдер",
  operator: "оператор (тестовый провайдер)",
  system: "система, по времени",
};

const OUTCOME_TEXT: Record<SubscriptionHistoryEntry["outcome"], string> = {
  pending: "ждёт применения",
  applied: "применено",
  no_effect: "без изменений",
  refused: "отклонено",
};

const DETAIL_TEXT: Record<string, string> = {
  stale: "событие старше уже применённого",
  no_change: "ничего нового",
  duplicate: "повтор",
  linked_to_another_account: "покупка привязана к другому аккаунту",
  already_active: "у аккаунта уже действует другая подписка",
  not_applicable: "такого события у этой подписки нет",
  no_subscription: "подписки с этой покупкой нет",
  no_account: "провайдер не назвал аккаунт",
  replaced_previous: "прежняя подписка закончилась",
  // TASK-041.
  unknown_product: "продукт стора не входит в тариф",
};

/** «применено», «без изменений: событие старше уже применённого». */
export function outcomeText(entry: Pick<SubscriptionHistoryEntry, "outcome" | "detail">): string {
  const outcome = OUTCOME_TEXT[entry.outcome];
  const detail = entry.detail ? (DETAIL_TEXT[entry.detail] ?? entry.detail) : null;
  return detail ? `${outcome}: ${detail}` : outcome;
}

/** Whose access it is: «по подписке», «выдан вручную». */
export function accessSourceText(state: ClubAccessState): string | null {
  if (!state.granted || !state.source) return null;
  return state.source === "subscription" ? "по подписке" : "выдан вручную";
}
