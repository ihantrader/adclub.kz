import { isLang, pickLanguage, type Lang } from "@adclub/i18n";

/**
 * What the cabinet keeps in this browser (`localStorage`): conveniences
 * only. No token is ever stored — the refresh token is an HttpOnly cookie,
 * the access token lives in memory (TASK-031 requirement 2). The theme is
 * kept by `ThemeProvider` under its own key (`theme.tsx`).
 */
const KEYS = {
  language: "adclub.supplier-web.language",
  supplier: "adclub.supplier-web.supplier",
  installOffered: "adclub.supplier-web.install-offered",
  lastKnown: "adclub.supplier-web.last-known",
  notificationLanguageSet: "adclub.supplier-web.notification-language-set",
} as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode or storage switched off: the cabinet works without it.
  }
}

/** The stored interface language, else the browser's (kk/ru/en), else Russian. */
export function storedLanguage(): Lang {
  const stored = read(KEYS.language);
  if (stored && isLang(stored)) return stored;
  const browser =
    typeof navigator === "undefined" ? undefined : (navigator.languages ?? [navigator.language]);
  return pickLanguage(browser?.join(","));
}

export function storeLanguage(lang: Lang): void {
  write(KEYS.language, lang);
}

/**
 * The company chosen at the last sign-in (S-AUTH-03): sent with the next
 * code, so the next sign-in goes straight into it. If the employee was
 * removed from it, the server just asks to choose again.
 */
export function rememberedSupplier(): string | undefined {
  return read(KEYS.supplier) ?? undefined;
}

export function rememberSupplier(supplierId: string): void {
  write(KEYS.supplier, supplierId);
}

/** S-INST-01 is offered once, after the first sign-in in this browser. */
export function installOffered(): boolean {
  return read(KEYS.installOffered) === "1";
}

export function markInstallOffered(): void {
  write(KEYS.installOffered, "1");
}

/**
 * The names the header showed last time, so the cabinet opened without a
 * network still shows its shell with the company (SCREENS 2.4). Cleared on
 * sign-out.
 */
export interface LastKnown {
  supplierName: string;
  memberName: string;
}

export function lastKnown(): LastKnown | null {
  try {
    const value: unknown = JSON.parse(read(KEYS.lastKnown) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as LastKnown).supplierName === "string" &&
      typeof (value as LastKnown).memberName === "string"
    ) {
      return value as LastKnown;
    }
  } catch {
    // A damaged value is no value.
  }
  return null;
}

export function storeLastKnown(value: LastKnown | null): void {
  write(KEYS.lastKnown, value === null ? null : JSON.stringify(value));
}

/**
 * Employees whose notification language this browser has already set or
 * seen chosen (SCREENS 6.0: it follows the interface by default).
 */
export function notificationLanguageSettled(memberId: string): boolean {
  return (read(KEYS.notificationLanguageSet) ?? "").split(",").includes(memberId);
}

export function settleNotificationLanguage(memberId: string): void {
  const ids = new Set((read(KEYS.notificationLanguageSet) ?? "").split(",").filter(Boolean));
  ids.add(memberId);
  write(KEYS.notificationLanguageSet, [...ids].slice(-20).join(","));
}

/** Everything that belongs to the signed-in person, not to the browser. */
export function forgetPerson(): void {
  write(KEYS.lastKnown, null);
}
