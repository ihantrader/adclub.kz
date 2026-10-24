import type { IconName } from "@adclub/ui-core";
import { Icon } from "@adclub/ui";
import { useEffect, type MouseEvent } from "react";
import { useT } from "../i18n";
import { useModerationUnseen } from "../moderation/unseen";
import { useWide } from "../offers/use-wide";
import { useInstallWay } from "../pwa/install";
import { PageHeader } from "./PageHeader";
import { navigate, routePaths, type StaticRoute } from "../router";

/** A row of a menu that is a real link (opens in a new tab with a modifier). */
export function MenuLink({
  route,
  icon,
  label,
  count,
  countLabel,
}: {
  route: StaticRoute;
  icon: IconName;
  label: string;
  /** A counter beside the label (unseen decisions of «Модерация»); 0 or none — no counter. */
  count?: number | null;
  countLabel?: string;
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
      {count ? (
        <span className="ac-count" aria-label={countLabel}>
          {count}
        </span>
      ) : null}
      <Icon name="chevronRight" size={20} className="ac-muted" />
    </a>
  );
}

/**
 * «Ещё» (SCREENS 6.6): what is not a tab, in the order of the side menu.
 * «Установить на экран» — only where it isn't installed. From 1024 px the
 * side menu lists these sections itself: the page would repeat it, so it
 * gives way to «Мои настройки» (TASK-079).
 */
export function More({ generation }: { generation: number | null }) {
  const t = useT();
  const wide = useWide();
  const installWay = useInstallWay();
  const unseen = useModerationUnseen(generation);
  useEffect(() => {
    if (wide) navigate("settings", { replace: true });
  }, [wide]);
  return (
    <>
      <PageHeader title={t("more.title")} />
      <nav className="menu" aria-label={t("more.title")}>
        <MenuLink
          route="moderation"
          icon="checklist"
          label={t("nav.moderation")}
          count={unseen}
          countLabel={unseen ? t("moderation.badgeLabel", { n: unseen }) : undefined}
        />
        <MenuLink route="team" icon="users" label={t("nav.team")} />
        <MenuLink route="company" icon="store" label={t("nav.company")} />
        <MenuLink route="settings" icon="settings" label={t("nav.settings")} />
        {installWay !== "installed" && (
          <MenuLink route="install" icon="download" label={t("nav.install")} />
        )}
      </nav>
    </>
  );
}
