import type { SupplierStats, SupplierStatsPeriod } from "@adclub/contracts";
import { calendarDayOf, formatDayMonth, type Lang } from "@adclub/i18n";

/**
 * The words of S-STAT-01 «Статистика» (TASK-071). Every number is the
 * server's (`GET /supplier/stats`): the page only says it.
 */

export const STATS_PERIODS: readonly SupplierStatsPeriod[] = ["7", "30", "90"];

export const DEFAULT_STATS_PERIOD: SupplierStatsPeriod = "30";

/** The period of the address (`/stats?period=7`); anything else — the default. */
export function periodOf(search: string): SupplierStatsPeriod {
  const value = new URLSearchParams(search).get("period");
  return (STATS_PERIODS as readonly string[]).includes(value ?? "")
    ? (value as SupplierStatsPeriod)
    : DEFAULT_STATS_PERIOD;
}

/** The address of a period: the default one is the bare `/stats`. */
export function statsAddress(period: SupplierStatsPeriod): string {
  return period === DEFAULT_STATS_PERIOD ? "/stats" : `/stats?period=${period}`;
}

/** «10 ноября» — a day of the period in the interface's language. */
export function dayText(day: string, lang: Lang): string {
  const calendar = calendarDayOf(day);
  return calendar ? formatDayMonth(calendar, lang) : day;
}

/** «1 240» — a whole number with the thin groups of the language. */
export function numberText(value: number, lang: Lang): string {
  return value.toLocaleString(lang === "en" ? "en-US" : "ru-RU");
}

/** A share: «75 %», or `null` — «Мало заявок для оценки». */
export function percentText(percent: number | null): string | null {
  return percent === null ? null : `${String(percent)} %`;
}

/** «4,6» / «4.6» — the rating to one decimal. */
export function ratingText(score: number, lang: Lang): string {
  return score.toLocaleString(lang === "en" ? "en-US" : "ru-RU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** No order in the period: «За этот период заявок не было» (views and the rating are still shown). */
export function noOrders(stats: SupplierStats): boolean {
  return stats.orders.total === 0;
}
