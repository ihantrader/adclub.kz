import { isApiError } from "@adclub/api-client";
import type {
  AccountCar,
  AdminUserListQuery,
  CatalogLanguage,
  ClubAccessGrantStatus,
  ClubAccessState,
} from "@adclub/contracts";
import { actionErrorText, validationText } from "../errors";

/**
 * The words of «Пользователи» (TASK-036.B; SCREENS A-USR-01…03): club
 * access in place of the stores' subscriptions (TASK-040), the grants'
 * history, the garage, the sessions, the refusals. Nothing here decides
 * anything — access is `ClubAccess` on the server.
 */

/** «31.12.2026» — a moment as a date of Almaty. */
export function dateText(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * The last day a grant ending at `iso` still works, in Almaty: the operator
 * command ends a grant at the start of the next day (`--until 2026-12-31` →
 * 2027-01-01 00:00), the admin panel at 23:59:59 of the day — both read
 * «31.12.2026».
 */
export function lastDayText(iso: string): string {
  return dateText(new Date(Date.parse(iso) - 1000).toISOString());
}

/** Club access now, in a line: «до 31.12.2026» (inclusive) or «нет». */
export function accessText(state: ClubAccessState): string {
  return state.granted && state.validUntil ? `до ${lastDayText(state.validUntil)}` : "нет";
}

export const GRANT_STATUS_TEXT: Record<ClubAccessGrantStatus, string> = {
  active: "действует",
  expired: "истекла",
  revoked: "отозвана",
  replaced: "заменена новой выдачей",
};

export const LANGUAGE_TEXT: Record<CatalogLanguage, string> = {
  kk: "Қазақша",
  ru: "Русский",
  en: "English",
};

const PLATFORM_TEXT: Record<string, string> = {
  ios: "iPhone",
  android: "Android",
  web: "Браузер",
};

/** «iPhone 15 · iPhone · 1.4.2» — what a session runs on. */
export function deviceText(session: {
  deviceName: string | null;
  platform: string | null;
  clientVersion: string | null;
}): string {
  return (
    [
      session.deviceName,
      session.platform ? (PLATFORM_TEXT[session.platform] ?? session.platform) : null,
      session.clientVersion ? `версия ${session.clientVersion}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Устройство не назвалось"
  );
}

/** «Geely Atlas 2023 · II (FX11) · JLH-4G20TDB» — a car of the garage. */
export function carText(car: AccountCar): string {
  const head = [car.make.label, car.model.label, car.year ? String(car.year) : null]
    .filter(Boolean)
    .join(" ");
  const rest = [car.generation, car.body, car.engine, car.transmission, car.drive]
    .map((level) => level?.label)
    .filter(Boolean);
  return [head, ...rest].join(" · ");
}

/** The filters of A-USR-01 kept in the address, for the server. */
export function userFiltersOf(query: URLSearchParams): Omit<AdminUserListQuery, "limit"> {
  const access = query.get("clubAccess");
  const days = Number(query.get("expiringDays"));
  return {
    q: query.get("q")?.trim() || undefined,
    clubAccess:
      access === "active" || access === "none" || access === "expiring" ? access : undefined,
    expiringDays: Number.isInteger(days) && days >= 1 && days <= 366 ? days : 7,
    noShows: query.get("noShows") === "true" ? "true" : undefined,
    unconfirmedCar: query.get("unconfirmedCar") === "true" ? "true" : undefined,
  };
}

/**
 * The mark of a car about its registration certificate (D-064, TASK-057):
 * «Документ показан · 10.10.2026», «Документ не подтверждён» (chosen from the
 * list after recognition did not work), «Без отметки» (added before TASK-057).
 * Never «владение подтверждено»: a document read is not proof of owning a car.
 */
export function carDocumentText(
  document: AccountCar["document"],
  moment: (iso: string) => string,
): string {
  if (document?.status === "shown") return `Документ показан · ${moment(document.at)}`;
  if (document?.status === "unconfirmed") return `Документ не подтверждён · ${moment(document.at)}`;
  return "Без отметки о документе";
}

/**
 * The end of a chosen day in Almaty, as a grant's `validUntil` (the date is
 * inclusive, as the operator command takes it); `null` — not a date.
 */
export function grantUntil(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const end = new Date(`${date}T23:59:59+05:00`);
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}

/** The last day of this year in Almaty, `YYYY-MM-DD` — the default end of a grant. */
export function endOfYear(now = new Date()): string {
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
  }).format(now);
  return `${year}-12-31`;
}

/** A refused change of a user's access or sessions, in words. */
export function userErrorText(error: unknown): string {
  if (!isApiError(error)) return actionErrorText(error);
  switch (error.code) {
    case "CLUB_ACCESS_NOT_GRANTED":
      return "Отзывать нечего: действующей выдачи клубного доступа нет. Обновите страницу";
    case "VALIDATION_ERROR": {
      const text = validationText(error) ?? "";
      if (/future/i.test(text)) return "Дата окончания — в будущем";
      if (/days ahead/i.test(text)) return "Дата окончания — не дальше чем через два года";
      return text || "Проверьте введённое";
    }
    case "NOT_FOUND":
      return "Не найдено — возможно, сессия уже завершена. Обновите страницу";
    default:
      return actionErrorText(error);
  }
}
