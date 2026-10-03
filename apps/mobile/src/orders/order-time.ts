/**
 * Moments of an order as a person reads them (TASK-030): «Ответит до 15:30»,
 * «Резерв до 15:00, 15 марта», «Получено 3 октября в 14:05», «Обновлено в
 * 10:12». Like the prices and dates of the catalog (`catalog/format.ts`),
 * the words are written out here and the month names come from the
 * dictionary — the engine of the app does not decide how a date reads.
 *
 * The one thing taken from `Intl` is the time zone arithmetic: the moment
 * of the server is shown in the zone of the pickup point (or the club's,
 * Asia/Almaty, before the point is known). If the engine cannot convert
 * (an unknown zone, no `formatToParts`), the device's own clock is used —
 * every city of Kazakhstan is in one zone, so this is the same answer there.
 */

/** The club's zone: months of the history and times of an order before its point is known. */
export const CLUB_TIME_ZONE = "Asia/Almaty";

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterOf(timeZone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null;
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      if (typeof formatter.formatToParts !== "function") formatter = null;
    } catch {
      formatter = null;
    }
    formatters.set(timeZone, formatter);
  }
  return formatters.get(timeZone) ?? null;
}

function deviceParts(date: Date): ZonedParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

/** The calendar date and the clock of a moment in a zone; `null` for an unreadable moment. */
export function zonedParts(iso: string, timeZone: string | null): ZonedParts | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const formatter = timeZone ? formatterOf(timeZone) : null;
  if (!formatter) return deviceParts(date);
  try {
    const parts: Partial<Record<string, number>> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const { year, month, day, hour, minute } = parts;
    if (
      [year, month, day, hour, minute].some((value) => value === undefined || Number.isNaN(value))
    ) {
      return deviceParts(date);
    }
    return { year: year!, month: month!, day: day!, hour: hour! % 24, minute: minute! };
  } catch {
    return deviceParts(date);
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

/** «15:30». */
export function clockText(parts: ZonedParts): string {
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** «15 марта» — the month name is the dictionary's (`month.1` … `month.12`). */
export function dayText(
  parts: { month: number; day: number },
  monthName: (month: number) => string,
) {
  return `${parts.day} ${monthName(parts.month)}`;
}

/** Whether two moments fall on the same calendar day of a zone. */
export function sameDay(a: ZonedParts, b: ZonedParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * «15:30» on the same day as `now`, «15:30, 15 марта» on another one — a
 * deadline is read by its clock first, and the date is added only when it
 * is not today.
 */
export function deadlineText(
  iso: string,
  timeZone: string | null,
  now: Date,
  monthName: (month: number) => string,
): string | null {
  const at = zonedParts(iso, timeZone);
  const today = zonedParts(now.toISOString(), timeZone);
  if (!at || !today) return null;
  return sameDay(at, today) ? clockText(at) : `${clockText(at)}, ${dayText(at, monthName)}`;
}

/**
 * «Обновлено в 10:12» while the copy is less than a day old, «Обновлено 3
 * октября» after that (SCREENS «Сохранённая копия»). The moment is the
 * server's (`serverTime`), shown on the device's clock — it answers «when
 * did I last see the truth», which is the person's own time.
 */
export type UpdatedLabel =
  { kind: "time"; time: string } | { kind: "date"; date: { month: number; day: number } };

export const DAY_MS = 24 * 60 * 60 * 1000;

export function updatedLabel(serverTime: string, now: Date): UpdatedLabel | null {
  const at = new Date(serverTime);
  if (Number.isNaN(at.getTime())) return null;
  const parts = deviceParts(at);
  if (now.getTime() - at.getTime() >= DAY_MS) {
    return { kind: "date", date: { month: parts.month, day: parts.day } };
  }
  return { kind: "time", time: clockText(parts) };
}
