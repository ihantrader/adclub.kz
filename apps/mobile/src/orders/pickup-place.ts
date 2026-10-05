import type { DayHours } from "@adclub/contracts";

/**
 * The place of an accepted order (M-ORD-03, D-026): the hours of the point
 * in a few lines, and the way out of the app to the place — a navigation app
 * of the person's choice by the address (calling is `call-options.ts`).
 * Every value comes from the server's `pickupPoint`; nothing is filled in.
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

/** The navigation apps «Маршрут» offers (TASK-030.A), in the order of the sheet. */
export type NavigatorId = "yandexMaps" | "yandexNavi" | "twoGis" | "googleMaps" | "appleMaps";

export interface NavigatorLink {
  id: NavigatorId;
  /** Opens the app itself; fails when it is not installed. */
  app: string;
  /** The same search in the browser — where a press goes when the app is not there. */
  web: string;
}

/**
 * «Маршрут» → «Открыть в…» (SCREENS M-ORD-03, TASK-030.A): the address the
 * server gave, as a **search** in each navigation app — a pickup point has
 * an address and no coordinates yet, so the app finds the place and the
 * route is built there. Every entry has a web address of the same service,
 * so no choice leads nowhere when the app is not installed (Yandex
 * Navigator has no web of its own: its search opens in Yandex Maps). Apple
 * Maps only on iOS. `[]` — no address to go to.
 */
export function navigatorLinks(
  place: { address: string | null; cityName: string },
  platform: "ios" | "android" | "web" | string,
): NavigatorLink[] {
  if (!place.address || place.address.trim() === "") return [];
  const query = encodeURIComponent(`${place.cityName}, ${place.address.trim()}`);
  const yandexWeb = `https://yandex.kz/maps/?text=${query}`;
  const googleWeb = `https://www.google.com/maps/search/?api=1&query=${query}`;
  const links: NavigatorLink[] = [
    { id: "yandexMaps", app: `yandexmaps://maps.yandex.ru/?text=${query}`, web: yandexWeb },
    { id: "yandexNavi", app: `yandexnavi://map_search?text=${query}`, web: yandexWeb },
    { id: "twoGis", app: `dgis://2gis.ru/search/${query}`, web: `https://2gis.kz/search/${query}` },
    {
      id: "googleMaps",
      // On Android the Maps URL itself opens the Google Maps app (an app
      // link) and the browser without it; iOS has a scheme of its own.
      app: platform === "ios" ? `comgooglemaps://?q=${query}` : googleWeb,
      web: googleWeb,
    },
  ];
  if (platform === "ios") {
    links.push({
      id: "appleMaps",
      app: `maps://?q=${query}`,
      web: `https://maps.apple.com/?q=${query}`,
    });
  }
  return links;
}

/**
 * Opens a navigator: the app, and the web of the same service when the app
 * is not installed (the system refuses its link). `false` — neither opened.
 */
export async function openNavigator(
  link: NavigatorLink,
  open: (url: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    await open(link.app);
    return true;
  } catch {
    try {
      await open(link.web);
      return true;
    } catch {
      return false;
    }
  }
}
