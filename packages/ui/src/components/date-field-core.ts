/**
 * The logic of the date field (TASK-079): the mask «ДД.ММ.ГГГГ» a person
 * types into, the reading of what was typed, and the month grid of the
 * calendar with its keyboard. Dates travel as `YYYY-MM-DD` — the form of
 * the server; the text is only what the field shows.
 */

/** Digits typed so far, laid into «ДД.ММ.ГГГГ»: «1712» → «17.12», «17122026» → «17.12.2026». */
export function maskDateText(typed: string): string {
  const digits = typed.replace(/\D/g, "").slice(0, 8);
  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);
  // A dot follows a complete part as soon as it is typed, so the next digit lands after it.
  let text = day;
  if (digits.length >= 2) text += ".";
  text += month;
  if (digits.length >= 4) text += ".";
  return text + year;
}

/**
 * The same text when a person deletes: a dot the mask added is removed with
 * the digit before it, so Backspace never sticks on «17.».
 */
export function maskAfterDelete(previous: string, typed: string): string {
  if (typed.length < previous.length && previous.endsWith(".") && typed === previous.slice(0, -1)) {
    return maskDateText(typed.slice(0, -1));
  }
  return maskDateText(typed);
}

export type DateTextReading =
  { kind: "empty" } | { kind: "partial" } | { kind: "invalid" } | { kind: "date"; iso: string };

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function isoOf(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** What the text says: nothing, not all typed yet, a day that doesn't exist, or the date. */
export function readDateText(text: string): DateTextReading {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 0) return { kind: "empty" };
  if (digits.length < 8) return { kind: "partial" };
  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 8));
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) {
    return { kind: "invalid" };
  }
  return { kind: "date", iso: isoOf(year, month, day) };
}

/** `YYYY-MM-DD` → «ДД.ММ.ГГГГ»; anything else — empty. */
export function dateTextOf(iso: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

/** The parts of an ISO date. */
export function partsOf(iso: string): { year: number; month: number; day: number } {
  const [year = "1970", month = "1", day = "1"] = iso.split("-");
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** A date moved by `days` (negative — back). */
export function addDays(iso: string, days: number): string {
  const { year, month, day } = partsOf(iso);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return isoOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** The same day of another month, held to the month's last day (31 January + 1 → 28 February). */
export function addMonths(iso: string, months: number): string {
  const { year, month, day } = partsOf(iso);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  return isoOf(y, m, Math.min(day, daysIn(y, m)));
}

/** Monday 1 … Sunday 7. */
export function weekdayOf(iso: string): number {
  const { year, month, day } = partsOf(iso);
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

/**
 * The weeks of a month, Monday first; the days of the neighbouring months
 * are `null` (the calendar shows only the month itself).
 */
export function monthWeeks(year: number, month: number): (string | null)[][] {
  const first = isoOf(year, month, 1);
  const lead = weekdayOf(first) - 1;
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysIn(year, month); day++) cells.push(isoOf(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

export type CalendarKey =
  "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";

export function isCalendarKey(key: string): key is CalendarKey {
  return [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].includes(key);
}

/** Where a key moves the highlighted day of the calendar (the grid pattern of WAI-ARIA). */
export function moveDay(iso: string, key: CalendarKey): string {
  switch (key) {
    case "ArrowLeft":
      return addDays(iso, -1);
    case "ArrowRight":
      return addDays(iso, 1);
    case "ArrowUp":
      return addDays(iso, -7);
    case "ArrowDown":
      return addDays(iso, 7);
    case "Home":
      return addDays(iso, 1 - weekdayOf(iso));
    case "End":
      return addDays(iso, 7 - weekdayOf(iso));
    case "PageUp":
      return addMonths(iso, -1);
    case "PageDown":
      return addMonths(iso, 1);
  }
}

/** Whether a day may be chosen: not before `min`, not after `max` (both `YYYY-MM-DD`). */
export function dayAllowed(iso: string, min?: string, max?: string): boolean {
  return (!min || iso >= min) && (!max || iso <= max);
}
