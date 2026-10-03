import type { DayHours } from "@adclub/contracts";

/**
 * «Поставщик и место» once the order is accepted (M-ORD-03, D-026): the
 * hours of the point in a few lines, and the two links that leave the app —
 * the system maps by the address and the system dialer by the phone. Every
 * value comes from the server's `pickupPoint`; nothing is filled in.
 */

/** Days 1 (Monday) … 7 (Sunday) that share the same hours, in a row. */
export interface HoursLine {
  fromDay: number;
  toDay: number;
  /** `null` — closed; `"allDay"` — round the clock; otherwise «09:00–13:00, 14:00–18:00». */
  hours: string | "allDay" | null;
}

function hoursOf(day: DayHours | undefined): HoursLine["hours"] {
  if (!day || day.intervals.length === 0) return null;
  if (
    day.intervals.length === 1 &&
    day.intervals[0]!.from === "00:00" &&
    day.intervals[0]!.to === "24:00"
  ) {
    return "allDay";
  }
  return day.intervals.map((interval) => `${interval.from}–${interval.to}`).join(", ");
}

/** «Пн–Пт 09:00–18:00 · Сб 10:00–16:00 · Вс выходной»: consecutive days with the same hours together. */
export function weeklyHoursLines(weeklyHours: readonly DayHours[] | null): HoursLine[] {
  if (!weeklyHours || weeklyHours.length === 0) return [];
  const lines: HoursLine[] = [];
  for (let day = 1; day <= 7; day += 1) {
    const hours = hoursOf(weeklyHours.find((entry) => entry.day === day));
    const last = lines[lines.length - 1];
    if (last && last.hours === hours && last.toDay === day - 1) last.toDay = day;
    else lines.push({ fromDay: day, toDay: day, hours });
  }
  return lines;
}

/**
 * The system maps searching for the address (SCREENS M-ORD-03 «Маршрут»):
 * Apple Maps on iOS, the `geo:` intent on Android (whichever maps app the
 * person uses answers it), a web map elsewhere. `null` — no address to go to.
 */
export function mapsUrl(
  place: { address: string | null; cityName: string },
  platform: "ios" | "android" | "web" | string,
): string | null {
  if (!place.address || place.address.trim() === "") return null;
  const query = encodeURIComponent(`${place.cityName}, ${place.address}`);
  if (platform === "ios") return `maps://?q=${query}`;
  if (platform === "android") return `geo:0,0?q=${query}`;
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** The system dialer (SCREENS M-ORD-03 «Позвонить»); `null` — no phone. */
export function callUrl(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length > 0 ? `tel:${digits}` : null;
}
