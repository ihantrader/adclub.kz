/** A no-break space: «12 500 ₸», «16 окт., 15:31» never split at the end of a line. */
export const NBSP = String.fromCharCode(0xa0);

/** The club's time zone: the admin panel shows moments as Almaty sees them (ARCHITECTURE 13.3). */
export const CLUB_TIME_ZONE = "Asia/Almaty";

const parts = new Intl.DateTimeFormat("ru-RU", {
  timeZone: CLUB_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function pieces(date: Date): Record<string, string> {
  const found: Record<string, string> = {};
  for (const part of parts.formatToParts(date)) found[part.type] = part.value;
  return found;
}

/**
 * «16 окт., 15:31» — a moment in Almaty time, in one line; the year only
 * when it is not the current one: «16 окт. 2025, 15:31» (TASK-080, X19).
 * The spaces inside are non-breaking: a table never splits a date.
 */
export function formatMoment(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const at = pieces(date);
  const year = at.year === pieces(now).year ? "" : `\u00a0${at.year ?? ""}`;
  return `${at.day ?? ""}\u00a0${at.month ?? ""}${year},\u00a0${at.hour ?? ""}:${at.minute ?? ""}`;
}

/** «16 окт.» (or «16 окт. 2025») — the day of a moment, in Almaty time. */
export function formatDay(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const at = pieces(date);
  const year = at.year === pieces(now).year ? "" : `\u00a0${at.year ?? ""}`;
  return `${at.day ?? ""}\u00a0${at.month ?? ""}${year}`;
}

/** «12 500 ₸» — a sum, never split between the number and the tenge. */
export function formatMoney(amount: number): string {
  return `${amount.toLocaleString("ru-RU")}\u00a0₸`;
}

/** A full number of one's own account, as people read it. */
export { formatPhone } from "@adclub/web-session";
