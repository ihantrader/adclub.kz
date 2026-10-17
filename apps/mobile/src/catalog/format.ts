/**
 * Numbers and dates of the catalog, written out rather than taken from
 * `Intl`: the engine of the app (Hermes) is built with a locale set we do
 * not control, and a price that groups its digits differently on two phones
 * is a visible defect. Month names come from the dictionary, so they are
 * translated like every other text.
 */

export const NBSP = " ";

/** Between the parts of one line: «Geely · 04465-0K090», «1 шт. · 12 700 ₸». */
export const DOT = `${NBSP}·${NBSP}`;

/**
 * Parts of one line through «·» (TASK-078 M11): the spaces around the dot
 * are non-breaking, so a line never starts or ends with a lone «·» — a
 * long line wraps inside its parts, never at the separator. Empty parts
 * are left out, so the line never opens with a dot either.
 */
export function joinDot(parts: readonly (string | null | undefined | false)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(DOT);
}

/** «12 500 ₸» — groups of three, a non-breaking space, the sign last. */
export function formatTenge(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "−" : "";
  const digits = String(Math.abs(rounded));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return `${sign}${groups.join(NBSP)}${NBSP}₸`;
}

/** A date of the server (`YYYY-MM-DD`) as parts; `null` for anything else. */
export function parseDate(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function toUtc(date: string): number | null {
  const parts = parseDate(date);
  return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) : null;
}

/** Whole days between two dates of the server; `null` when either is unusable. */
export function daysBetween(from: string, to: string): number | null {
  const start = toUtc(from);
  const end = toUtc(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / 86_400_000);
}

export type ReceiptDay =
  { kind: "today" } | { kind: "tomorrow" } | { kind: "date"; month: number; day: number };

/**
 * «Сегодня» / «Завтра» / «14 марта» — always against the pickup point's own
 * today (`confirmedOn`), never the phone's clock: the point may be in
 * another time zone, and «завтра» must mean the supplier's tomorrow.
 */
export function receiptDay(date: string, confirmedOn: string): ReceiptDay | null {
  const parts = parseDate(date);
  if (!parts) return null;
  const offset = daysBetween(confirmedOn, date);
  if (offset === 0) return { kind: "today" };
  if (offset === 1) return { kind: "tomorrow" };
  return { kind: "date", month: parts.month, day: parts.day };
}
