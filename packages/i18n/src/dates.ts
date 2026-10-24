import type { Lang } from "./translate";

/**
 * Dates in words for the supplier cabinet and the app (TASK-080 requirement
 * 7): the names of months and weekdays are ours, not the browser's. A
 * browser without Kazakh data in `Intl` (the built-in browser of a computer,
 * a phone with a cut set of languages) wrote «M10 21, 09:11» for «21 қазан,
 * 09:11». Numbers and the time come from `Intl` with a numeric `en-US`,
 * which every engine has. The forms follow what full ICU says (CLDR), so a
 * screen reads the same as before where the browser had the data.
 */

/** A day of the calendar; `weekday` — 1 Monday … 7 Sunday. */
export interface CalendarDay {
  year: number;
  /** 1 … 12. */
  month: number;
  day: number;
  weekday: number;
}

/** A moment on the clock of a time zone. */
export interface ZonedMoment extends CalendarDay {
  hour: number;
  minute: number;
}

interface Names {
  /** The month with a day: «21 октября», «21 қазан», «October 21». */
  long: readonly string[];
  /** Short, with a day: «21 окт.», «21 қаз.», «Oct 21». */
  short: readonly string[];
  /** The month alone, for a month of a year: «октябрь», «қазан», «October». */
  standalone: readonly string[];
  weekdayShort: readonly string[];
  weekdayLong: readonly string[];
}

const NAMES: Record<Lang, Names> = {
  ru: {
    long: [
      "января",
      "февраля",
      "марта",
      "апреля",
      "мая",
      "июня",
      "июля",
      "августа",
      "сентября",
      "октября",
      "ноября",
      "декабря",
    ],
    short: [
      "янв.",
      "февр.",
      "мар.",
      "апр.",
      "мая",
      "июн.",
      "июл.",
      "авг.",
      "сент.",
      "окт.",
      "нояб.",
      "дек.",
    ],
    standalone: [
      "январь",
      "февраль",
      "март",
      "апрель",
      "май",
      "июнь",
      "июль",
      "август",
      "сентябрь",
      "октябрь",
      "ноябрь",
      "декабрь",
    ],
    weekdayShort: ["пн", "вт", "ср", "чт", "пт", "сб", "вс"],
    weekdayLong: [
      "понедельник",
      "вторник",
      "среда",
      "четверг",
      "пятница",
      "суббота",
      "воскресенье",
    ],
  },
  kk: {
    long: [
      "қаңтар",
      "ақпан",
      "наурыз",
      "сәуір",
      "мамыр",
      "маусым",
      "шілде",
      "тамыз",
      "қыркүйек",
      "қазан",
      "қараша",
      "желтоқсан",
    ],
    short: [
      "қаң.",
      "ақп.",
      "нау.",
      "сәу.",
      "мам.",
      "мау.",
      "шіл.",
      "там.",
      "қыр.",
      "қаз.",
      "қар.",
      "жел.",
    ],
    standalone: [
      "қаңтар",
      "ақпан",
      "наурыз",
      "сәуір",
      "мамыр",
      "маусым",
      "шілде",
      "тамыз",
      "қыркүйек",
      "қазан",
      "қараша",
      "желтоқсан",
    ],
    weekdayShort: ["дс", "сс", "ср", "бс", "жм", "сб", "жс"],
    weekdayLong: ["дүйсенбі", "сейсенбі", "сәрсенбі", "бейсенбі", "жұма", "сенбі", "жексенбі"],
  },
  en: {
    long: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
    short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    standalone: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
    weekdayShort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    weekdayLong: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  },
};

/** The language of a locale («kk-KZ» → kk); anything unknown reads as Russian. */
export function dateLangOf(locale: string): Lang {
  const lang = locale.slice(0, 2).toLowerCase();
  return lang === "kk" || lang === "en" ? lang : "ru";
}

/** The name of a month (1 … 12). */
export function monthName(
  month: number,
  lang: Lang,
  form: "long" | "short" | "standalone" = "long",
): string {
  return NAMES[lang][form][month - 1] ?? String(month);
}

/** The name of a weekday (1 Monday … 7 Sunday). */
export function weekdayName(
  weekday: number,
  lang: Lang,
  width: "short" | "long" = "short",
): string {
  const names = width === "short" ? NAMES[lang].weekdayShort : NAMES[lang].weekdayLong;
  return names[weekday - 1] ?? String(weekday);
}

/** Monday 1 … Sunday 7 of a day of the calendar. */
function weekdayOf(year: number, month: number, day: number): number {
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

/** A `YYYY-MM-DD` date as the server gives it (no time zone); `null` — not a date. */
export function calendarDayOf(date: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { year, month, day, weekday: weekdayOf(year, month, day) };
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/**
 * A moment on the wall clock of `timeZone`: numbers only, from a numeric
 * `en-US` format every engine has (no names are asked of `Intl`).
 */
export function zonedMomentOf(at: number | Date, timeZone: string): ZonedMoment {
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    clocks.set(timeZone, clock);
  }
  const parts: Record<string, number> = {};
  for (const part of clock.formatToParts(typeof at === "number" ? new Date(at) : at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const year = parts.year ?? 1970;
  const month = parts.month ?? 1;
  const day = parts.day ?? 1;
  return {
    year,
    month,
    day,
    weekday: weekdayOf(year, month, day),
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

/** «09:11». */
export function clockText(moment: Pick<ZonedMoment, "hour" | "minute">): string {
  return `${String(moment.hour).padStart(2, "0")}:${String(moment.minute).padStart(2, "0")}`;
}

/**
 * «21 октября» / «21 окт.», «21 қазан» / «21 қаз.», «October 21» / «Oct 21»
 * — a day of a month, in the order of its language.
 */
export function formatDayMonth(
  day: Pick<CalendarDay, "month" | "day">,
  lang: Lang,
  month: "long" | "short" = "long",
): string {
  const name = monthName(day.month, lang, month);
  return lang === "en" ? `${name} ${String(day.day)}` : `${String(day.day)} ${name}`;
}

/** «вт, 13 окт.», «13 қаз., сс», «Tue, Oct 13» — a day to choose (S-ORD-04). */
export function formatWeekdayDayMonth(day: CalendarDay, lang: Lang): string {
  const weekday = weekdayName(day.weekday, lang);
  const date = formatDayMonth(day, lang, "short");
  return lang === "kk" ? `${date}, ${weekday}` : `${weekday}, ${date}`;
}

/** «октябрь 2026 г.», «2026 ж. қазан», «October 2026» — a month of a year. */
export function formatMonthYear(year: number, month: number, lang: Lang): string {
  const name = monthName(month, lang, "standalone");
  if (lang === "kk") return `${String(year)} ж. ${name}`;
  if (lang === "ru") return `${name} ${String(year)} г.`;
  return `${name} ${String(year)}`;
}

/** «вт, 13 октября 2026 г.» / «2026 ж. 13 қазан, сс» / «Tue, October 13, 2026» — a whole date. */
export function formatFullDate(
  day: CalendarDay,
  lang: Lang,
  weekdayWidth: "short" | "long" = "short",
): string {
  const weekday = weekdayName(day.weekday, lang, weekdayWidth);
  const date = formatDayMonth(day, lang, "long");
  if (lang === "kk") return `${String(day.year)} ж. ${date}, ${weekday}`;
  if (lang === "ru") return `${weekday}, ${date} ${String(day.year)} г.`;
  return `${weekday}, ${date}, ${String(day.year)}`;
}

/** «21 қазан, 09:11» — a moment in `timeZone`, with its day and its time. */
export function formatDayTime(
  at: number | Date,
  timeZone: string,
  lang: Lang,
  month: "long" | "short" = "long",
): string {
  const moment = zonedMomentOf(at, timeZone);
  return `${formatDayMonth(moment, lang, month)}, ${clockText(moment)}`;
}
