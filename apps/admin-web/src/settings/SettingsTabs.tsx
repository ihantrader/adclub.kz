import { routePaths } from "../router";

const TABS = [
  { key: "settings", label: "Пороги и лимиты", href: routePaths.settings },
  { key: "clientPolicy", label: "Политика клиента", href: routePaths.clientPolicy },
  { key: "cities", label: "Города", href: routePaths.cities },
] as const;

export type SettingsTab = (typeof TABS)[number]["key"];

/** The three pages of «Настройки» (A-SET-01, A-SET-02, A-SET-06) — the tab bar of its `Header`. */
export function settingsTabs(active: SettingsTab) {
  return { label: "Настройки", items: TABS, active };
}

/** The way back from the history of one setting (X11: crumbs). */
export const SETTINGS_CRUMB = { label: "Настройки", href: routePaths.settings };
