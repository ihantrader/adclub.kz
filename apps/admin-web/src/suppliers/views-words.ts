import { conversionText } from "../signals/signal-words";

/** The periods of «Просмотры и заявки»: the last 7, 30 or 90 days of Almaty, today included. */
export const VIEW_PERIODS = [7, 30, 90] as const;
export type ViewPeriod = (typeof VIEW_PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of Almaty today. */
export function almatyToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The period of `?period=` (30 when left out or unknown) as the route takes it. */
export function viewPeriodRange(
  period: string | null,
  today = almatyToday(),
): { days: ViewPeriod; from: string; to: string } {
  const days = (VIEW_PERIODS as readonly number[]).includes(Number(period))
    ? (Number(period) as ViewPeriod)
    : 30;
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { days, from, to: today };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The range of the tab: the signal's own window when its link brought
 * `?from=&to=` (days of Almaty, not after today), otherwise `?period=`.
 * `days: null` — the signal's window. Without it the card showed the last 30
 * days to today, and the signal's «1 заявка на 95 просмотров» (30 days to
 * yesterday) did not match what the link opened.
 */
export function viewRangeOf(
  query: { period: string | null; from: string | null; to: string | null },
  today = almatyToday(),
): { days: ViewPeriod | null; from: string; to: string } {
  const { from, to } = query;
  if (from && to && DAY_RE.test(from) && DAY_RE.test(to) && from <= to && to <= today) {
    return { days: null, from, to };
  }
  return viewPeriodRange(query.period, today);
}

/** «14.11» of `2026-11-14`. */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${date ?? ""}.${month ?? ""}`;
}

/** A conversion, or a dash without views of members. */
export function conversionCell(conversion: number | null): string {
  return conversion === null ? "—" : conversionText(conversion);
}
