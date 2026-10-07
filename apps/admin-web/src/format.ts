/** The club's time zone: the admin panel shows moments as Almaty sees them (ARCHITECTURE 13.3). */
export const CLUB_TIME_ZONE = "Asia/Almaty";

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: CLUB_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** «7 окт. 2026 г., 14:02» — a moment, in Almaty time. */
export function formatMoment(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

/** A full number of one's own account, as people read it. */
export { formatPhone } from "@adclub/web-session";
