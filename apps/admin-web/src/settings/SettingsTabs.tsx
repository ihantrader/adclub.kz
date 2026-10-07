import type { MouseEvent } from "react";
import { navigateTo, routePaths } from "../router";

const TABS = [
  { key: "settings", label: "Пороги и лимиты", href: routePaths.settings },
  { key: "clientPolicy", label: "Политика клиента", href: routePaths.clientPolicy },
  { key: "cities", label: "Города", href: routePaths.cities },
] as const;

/** The three pages of «Настройки» (A-SET-01, A-SET-02, A-SET-06): real links with their own addresses. */
export function SettingsTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav className="page-tabs" aria-label="Настройки">
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          className={tab.key === active ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"}
          aria-current={tab.key === active ? "page" : undefined}
          onClick={(event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            navigateTo(tab.href);
          }}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
