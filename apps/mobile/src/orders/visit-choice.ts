import type { OfferVisitOptions } from "@adclub/contracts";
import { visitInstant, visitSlots } from "@adclub/domain";

/**
 * The day and the time of a visit on the checkout of a service (TASK-039.B;
 * SCREENS M-ORD-01 «Услуга»: «желаемая дата — только рабочие дни
 * поставщика, время — в пределах часов работы»). The days and their hours
 * are the server's (`GET /order-visit-options`) — the app knows no
 * schedule of a point; the times are those hours every half hour
 * (`visitSlots`), and the server judges the time again when it is sent.
 */

export interface VisitChoiceDay {
  /** `YYYY-MM-DD` at the point. */
  date: string;
  /** `HH:MM` at the point, in order. */
  times: string[];
}

/** The days to choose from, each with its times; a day with no time left is not offered. */
export function visitChoiceDays(options: Pick<OfferVisitOptions, "days">): VisitChoiceDay[] {
  return options.days
    .map((day) => ({ date: day.date, times: visitSlots(day.intervals) }))
    .filter((day) => day.times.length > 0);
}

export interface VisitChoice {
  date: string;
  /** `null` — the day is chosen, the time not yet. */
  time: string | null;
}

/**
 * The choice as it stands against the days of now: kept while its day and
 * time are still offered; a time no longer offered (the minute passed, the
 * hours changed) is dropped and its day kept; a day no longer offered (the
 * point closed it) — the first day, without a time. `null` — nothing to choose.
 */
export function settleVisitChoice(
  choice: VisitChoice | null,
  days: readonly VisitChoiceDay[],
): VisitChoice | null {
  const day = choice ? days.find((entry) => entry.date === choice.date) : undefined;
  if (!day) {
    const first = days[0];
    return first ? { date: first.date, time: null } : null;
  }
  return {
    date: day.date,
    time:
      choice?.time !== null && choice?.time !== undefined && day.times.includes(choice.time)
        ? choice.time
        : null,
  };
}

/**
 * How a day chip reads: «Сегодня», «Завтра», otherwise the day of the week
 * (1 — Monday … 7 — Sunday) with the date. `today` — the date at the point now.
 */
export type VisitDayLabel =
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "date"; weekday: number; month: number; day: number };

export function visitDayLabel(date: string, today: string): VisitDayLabel {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [y = 0, m = 1, d = 1] = today.split("-").map(Number);
  const days = (Date.UTC(year, month - 1, day) - Date.UTC(y, m - 1, d)) / 86_400_000;
  if (days === 0) return { kind: "today" };
  if (days === 1) return { kind: "tomorrow" };
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { kind: "date", weekday: weekday === 0 ? 7 : weekday, month, day };
}

/** `desiredAt` of `POST /orders`: the chosen time at the point; `null` — no time chosen yet. */
export function desiredAtOf(choice: VisitChoice | null, timeZone: string): string | null {
  return choice?.time ? visitInstant(choice.date, choice.time, timeZone) : null;
}
