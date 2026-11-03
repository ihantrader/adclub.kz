import { isApiError } from "@adclub/api-client";
import type {
  AdminBillingSupplier,
  AdminChargeStatus,
  AdminPlan,
  AdminUserSubscriptionListQuery,
  SupplierBillingGroup,
} from "@adclub/contracts";
import { formatDay, formatMoment } from "../format";
import { routePaths, withQuery } from "../router";
import { amountText } from "../suppliers/billing-words";

/**
 * The words and the addresses of «Биллинг» (SCREENS 7.8 A-BILL-01…04;
 * TASK-043). Nothing here counts or decides: every number is the server's,
 * and a card of the summary opens its list with the very filters the server
 * counted it with.
 */

export type BillingPage = "summary" | "users" | "payments" | "plans";

/** The pages of the section: one bar of tabs (X11). */
export function billingTabs(active: BillingPage) {
  return {
    label: "Биллинг",
    active,
    items: [
      { key: "summary" as const, label: "Сводка", href: routePaths.billing },
      { key: "users" as const, label: "Подписки пользователей", href: routePaths.billingUsers },
      { key: "payments" as const, label: "Платежи поставщиков", href: routePaths.billingPayments },
      { key: "plans" as const, label: "Тарифы", href: routePaths.billingPlans },
    ],
  };
}

// ------------------------------------------------------------ the period

/** `YYYY-MM-DD` of Almaty, `days` from the day of `now`. */
export function almatyDate(now: Date, days = 0): string {
  const shifted = new Date(now.getTime() + 5 * 3_600_000 + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** The start of a day of Almaty (UTC+5), as the API takes a period. */
export function dayStart(date: string, plusDays = 0): string {
  const start = new Date(`${date}T00:00:00+05:00`);
  start.setUTCDate(start.getUTCDate() + plusDays);
  return start.toISOString();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The period of the address (`from`, `to` — days of Almaty, `to`
 * included), or the last 30 days; for the API — `from` inclusive, `to`
 * exclusive.
 */
export function periodOf(
  query: URLSearchParams,
  now: Date = new Date(),
): { fromDay: string; toDay: string; from: string; to: string } {
  const fromDay = DATE.test(query.get("from") ?? "") ? query.get("from")! : almatyDate(now, -29);
  const toDay = DATE.test(query.get("to") ?? "") ? query.get("to")! : almatyDate(now);
  return { fromDay, toDay, from: dayStart(fromDay), to: dayStart(toDay, 1) };
}

// ------------------------------------------------- users' subscriptions

export const PLATFORM_TEXT: Record<"ios" | "android" | "other", string> = {
  ios: "iOS",
  android: "Android",
  other: "Прочие",
};

/** The filters of A-BILL-02 kept in the address, for the server. */
export function userSubscriptionFiltersOf(
  query: URLSearchParams,
): Omit<AdminUserSubscriptionListQuery, "limit" | "cursor"> {
  const value = (name: string) => query.get(name)?.trim() || undefined;
  const tab = value("tab");
  const platform = value("platform");
  const provider = value("provider");
  const days = Number(value("expiringDays"));
  const moment = (name: string) => {
    const text = value(name);
    return text && DATE.test(text)
      ? dayStart(text, name.endsWith("To") ? 1 : 0)
      : text && !Number.isNaN(Date.parse(text))
        ? text
        : undefined;
  };
  return {
    tab: tab === "ended" || tab === "all" ? tab : "active",
    status: value("status") as AdminUserSubscriptionListQuery["status"],
    platform:
      platform === "ios" || platform === "android" || platform === "other" ? platform : undefined,
    provider:
      provider === "store" || provider === "card_kz" || provider === "test" ? provider : undefined,
    expiringDays: Number.isInteger(days) && days >= 1 && days <= 366 ? days : undefined,
    startedFrom: moment("startedFrom"),
    startedTo: moment("startedTo"),
    endedFrom: moment("endedFrom"),
    endedTo: moment("endedTo"),
    q: value("q"),
    accountId: value("accountId"),
  };
}

/** «Все подписки» of a user's card: the section's list of that account. */
export function userSubscriptionsPath(accountId: string): string {
  return withQuery(routePaths.billingUsers, { tab: "all", accountId });
}

// --------------------------------------------------------- suppliers

export const GROUP_TEXT: Record<SupplierBillingGroup, string> = {
  paid: "Оплачено",
  declined: "Отказ банка",
  awaiting_provider: "Ждёт платёжную систему",
  paused: "Пауза по оплате",
  none: "Без подписки",
};

export const GROUP_HINT: Record<SupplierBillingGroup, string> = {
  paid: "Подписка оплачена, предложения на витрине",
  declined: "Банк отказал в списании, система повторяет попытки и пишет поставщику",
  awaiting_provider: "Списание ждёт ответа платёжной системы — это не отказ плательщика",
  paused: "Повторы кончились: предложения сняты с витрины, пока подписку не оплатят",
  none: "Карта не привязана или подписка закончилась",
};

/** The groups of «Неуспешные» and their order. */
export const FAILED_GROUPS: readonly SupplierBillingGroup[] = [
  "declined",
  "awaiting_provider",
  "paused",
];

export const ALL_GROUPS: readonly SupplierBillingGroup[] = [
  "paid",
  "declined",
  "awaiting_provider",
  "paused",
  "none",
];

/** The groups of the address (`groups=declined,paused`), only known ones. */
export function groupsOf(query: URLSearchParams): SupplierBillingGroup[] {
  return (query.get("groups") ?? "")
    .split(",")
    .filter((part): part is SupplierBillingGroup =>
      ALL_GROUPS.includes(part as SupplierBillingGroup),
    );
}

/**
 * A-BILL-03 with the groups a card counted: «Неуспешные» for the failure
 * groups, «Все поставщики» when a group of the others is asked.
 */
export function paymentsPath(groups: readonly SupplierBillingGroup[]): string {
  const failedOnly = groups.every((group) => FAILED_GROUPS.includes(group));
  return withQuery(routePaths.billingPayments, {
    tab: failedOnly ? undefined : "suppliers",
    groups: groups.join(","),
  });
}

export type PaymentsTab = "failed" | "suppliers" | "history";

export function paymentsTabOf(query: URLSearchParams): PaymentsTab {
  const tab = query.get("tab");
  return tab === "suppliers" || tab === "history" ? tab : "failed";
}

/** «История списаний» with its filters. */
export function chargesPath(values: Record<string, string | undefined>): string {
  return withQuery(routePaths.billingPayments, { tab: "history", ...values });
}

/** «через 2 дня», «сегодня» — the days to the pause. */
export function daysText(days: number): string {
  if (days === 0) return "сегодня";
  const tens = days % 100;
  const ones = days % 10;
  const word =
    tens >= 11 && tens <= 14
      ? "дней"
      : ones === 1
        ? "день"
        : ones >= 2 && ones <= 4
          ? "дня"
          : "дней";
  return `через ${String(days)} ${word}`;
}

/** What a row of «Неуспешные» says about the next try and the pause. */
export function failedFacts(row: AdminBillingSupplier): {
  next: string;
  pause: string | null;
} {
  if (row.group === "paused") {
    return {
      next: "Автоматических попыток больше не будет",
      pause: row.pausedSince ? `На паузе с ${formatDay(row.pausedSince)}` : "На паузе",
    };
  }
  if (row.group === "awaiting_provider" && row.waiting) {
    return {
      next: row.waiting.nextTryAt
        ? `Спросим платёжную систему ${formatMoment(row.waiting.nextTryAt)}`
        : "Спросим платёжную систему в ближайший час",
      pause: null,
    };
  }
  return {
    next: row.nextRetryAt
      ? formatMoment(row.nextRetryAt)
      : "Автоматических попыток больше не будет",
    pause:
      row.pauseAt && row.daysToPause !== null
        ? `${formatDay(row.pauseAt)} — ${daysText(row.daysToPause)}`
        : null,
  };
}

export const CHARGE_STATUS_TEXT: Record<AdminChargeStatus, string> = {
  succeeded: "Успешно",
  declined: "Отказ",
  unavailable: "Платёжная система недоступна",
  unknown: "Исход неизвестен",
  created: "Идёт списание",
};

export const CHARGE_STATUSES: readonly AdminChargeStatus[] = [
  "succeeded",
  "declined",
  "unavailable",
  "unknown",
];

// ------------------------------------------------------------ tariffs

export const PLAN_STATE_TEXT: Record<AdminPlan["state"], string> = {
  in_effect: "Действует",
  past: "В прошлом",
  announced: "Объявлен",
  scheduled: "Запланирован",
  cancelled: "Отменён",
};

export const PLAN_BY_TEXT: Record<AdminPlan["createdByRole"], string> = {
  operator: "оператор",
  admin: "администратор",
};

/** A sentence ending with a date: «с 5 нояб.» keeps its one dot, «с 5 мая» gets one. */
export function withPeriod(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** «С 12 нояб. тариф — 3 000 ₸ в месяц» (S-BILL-01). */
export function planLine(plan: Pick<AdminPlan, "validFrom" | "price">): string {
  return `С ${formatDay(plan.validFrom)} тариф — ${amountText(plan.price)} в месяц`;
}

/** The day of Almaty a record starts on (00:00 there). */
export function planDay(plan: Pick<AdminPlan, "validFrom">): string {
  return almatyDate(new Date(plan.validFrom));
}

/** A refusal of a new tariff, said at its field. */
export function planRefusal(error: unknown): {
  field: "startsOn" | "announceBeforeDays" | "price" | "reason" | null;
  text: string;
  earliest?: string;
} | null {
  if (!isApiError(error) || error.code !== "VALIDATION_ERROR") return null;
  const details = Array.isArray(error.details)
    ? (error.details[0] as { path?: unknown; earliest?: unknown; rise?: unknown } | undefined)
    : undefined;
  const path = typeof details?.path === "string" ? details.path : null;
  const earliest = typeof details?.earliest === "string" ? details.earliest : undefined;
  if (path === "startsOn") {
    if (earliest) {
      return {
        field: "startsOn",
        earliest,
        text:
          details?.rise === true
            ? `Повышение можно начать не раньше ${formatDay(dayStart(earliest))}: поставщиков нужно предупредить заранее`
            : `Тариф можно начать не раньше ${formatDay(dayStart(earliest))}`,
      };
    }
    return { field: "startsOn", text: "С этой даты тариф уже запланирован — выберите другую" };
  }
  if (path === "announceBeforeDays") {
    return { field: "announceBeforeDays", text: "О повышении нужно предупредить хотя бы за день" };
  }
  if (path === "price") return { field: "price", text: "Цена — целое число тенге от 1" };
  if (path === "reason") return { field: "reason", text: "Укажите причину" };
  return null;
}
