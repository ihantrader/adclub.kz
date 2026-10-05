import type { IconName } from "@adclub/ui-core";
import { Icon } from "@adclub/ui";
import type { MouseEvent } from "react";
import { useT } from "../i18n";
import { useInstallWay } from "../pwa/install";
import { navigate, routePaths, type StaticRoute } from "../router";

/** A row of a menu that is a real link (opens in a new tab with a modifier). */
export function MenuLink({
  route,
  icon,
  label,
}: {
  route: StaticRoute;
  icon: IconName;
  label: string;
}) {
  return (
    <a
      className="menu-row"
      href={routePaths[route]}
      onClick={(event: MouseEvent) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(route);
      }}
    >
      <Icon name={icon} size={24} />
      <span className="menu-row__label">{label}</span>
      <Icon name="chevronRight" size={20} className="ac-muted" />
    </a>
  );
}

/** «Ещё» (SCREENS 6.6): what is not a tab. «Установить на экран» — only where it isn't installed. */
export function More() {
  const t = useT();
  const installWay = useInstallWay();
  return (
    <>
      <h1 className="ac-text-title-l page__title">{t("more.title")}</h1>
      <nav className="menu" aria-label={t("more.title")}>
        <MenuLink route="settings" icon="settings" label={t("nav.settings")} />
        <MenuLink route="team" icon="users" label={t("nav.team")} />
        <MenuLink route="company" icon="store" label={t("nav.company")} />
        {installWay !== "installed" && (
          <MenuLink route="install" icon="download" label={t("nav.install")} />
        )}
      </nav>
    </>
  );
}
