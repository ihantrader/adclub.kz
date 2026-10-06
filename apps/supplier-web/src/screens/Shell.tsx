import {
  Banner,
  BottomTabs,
  FadeSwap,
  Button,
  Icon,
  IconButton,
  Logo,
  Sidebar,
  toastArea,
  type NavItem,
} from "@adclub/ui";
import { useEffect, useState, type ReactNode } from "react";
import { companyBanners } from "../cabinet/company-state";
import type { CabinetState } from "../cabinet/cabinet-store";
import { useOnline } from "../connection";
import { useT } from "../i18n";
import { refreshNewOrders, useNewOrders, useVisiblePoll } from "../orders/live";
import { useInstallWay } from "../pwa/install";
import { useAppUpdated } from "../pwa/service-worker";
import {
  goBackTo,
  menuOf,
  morePages,
  navigate,
  routePaths,
  tabOf,
  type RouteKey,
  type StaticRoute,
  useRouteId,
} from "../router";
import { CompanySwitchDialog } from "./CompanySwitch";

type Ready = Extract<CabinetState, { status: "ready" }>;

/** How often the other pages ask for «Новые · N» of the badge («Заявки» tells it with every answer). */
const BADGE_POLL_MS = 30_000;

export interface ShellProps {
  route: RouteKey;
  /** The loaded cabinet, or what the header knew last time (opened without a network). */
  cabinet: Ready | null;
  fallbackNames?: { supplierName: string; memberName: string } | null;
  children: ReactNode;
}

/**
 * The frame of every page (SCREENS 3.2, 6.0): the company in the header
 * always; on a phone — bottom tabs «Заявки · Предложения · Сканер · Ещё»
 * (no «Прайс» until stage C); from 1024 px — the side menu (DESIGN 7.5).
 * Banners above every page: no network, a new version, the company's state.
 */
export function Shell({ route, cabinet, fallbackNames, children }: ShellProps) {
  const t = useT();
  const online = useOnline();
  const updated = useAppUpdated();
  const installWay = useInstallWay();
  const [switching, setSwitching] = useState(false);
  const routeId = useRouteId();

  const supplierName = cabinet?.company.supplier.name ?? fallbackNames?.supplierName ?? "";
  const memberName = cabinet?.access.member.displayName ?? fallbackNames?.memberName ?? "";
  const canSwitch = (cabinet?.companies.length ?? 0) > 1;
  const banners = cabinet ? companyBanners(cabinet.company.company) : [];
  const generation = cabinet?.generation ?? null;
  const newOrders = useNewOrders(generation);
  // «Заявки» keep the count current themselves; elsewhere it is asked for alone.
  const askBadge = generation !== null && route !== "orders";
  useEffect(() => {
    if (askBadge) void refreshNewOrders(generation);
  }, [askBadge, generation]);
  useVisiblePoll(
    () => {
      if (generation !== null) void refreshNewOrders(generation);
    },
    BADGE_POLL_MS,
    askBadge,
  );
  const ordersItem: NavItem<StaticRoute> = {
    key: "orders",
    label: t("tabs.orders"),
    icon: "receipt",
    href: routePaths.orders,
    ...(newOrders !== null &&
      newOrders > 0 && {
        count: newOrders,
        countLabel: t("orders.badgeLabel", { n: newOrders }),
      }),
  };

  const tabs: NavItem<StaticRoute>[] = [
    ordersItem,
    { key: "offers", label: t("tabs.offers"), icon: "tags", href: routePaths.offers },
    { key: "more", label: t("tabs.more"), icon: "dots", href: routePaths.more },
  ];
  // The desktop menu lists the sections of «Ещё» directly (design/mockups/supplier.html).
  const menu: NavItem<StaticRoute>[] = [
    ordersItem,
    { key: "scan", label: t("tabs.scan"), icon: "scan", href: routePaths.scan },
    { key: "offers", label: t("tabs.offers"), icon: "tags", href: routePaths.offers },
    { key: "team", label: t("nav.team"), icon: "users", href: routePaths.team },
    { key: "company", label: t("nav.company"), icon: "store", href: routePaths.company },
    { key: "settings", label: t("nav.settings"), icon: "settings", href: routePaths.settings },
    ...(installWay === "installed"
      ? []
      : [
          {
            key: "install" as const,
            label: t("nav.install"),
            icon: "download" as const,
            href: routePaths.install,
          },
        ]),
  ];

  const companyChip = (
    <span className="company-chip__name" title={supplierName}>
      {supplierName}
    </span>
  );

  return (
    <div className="shell">
      <div className="shell__sidebar">
        <Sidebar<StaticRoute>
          label={t("nav.label")}
          items={menu}
          active={menuOf(route)}
          onSelect={(key) => navigate(key)}
          header={
            <div className="shell__sidebar-head">
              <Logo height={36} />
              <div className="sidebar-company">
                <span className="ac-text-caption ac-muted">{t("header.companyLabel")}</span>
                {canSwitch ? (
                  <button
                    type="button"
                    className="sidebar-company__button"
                    onClick={() => setSwitching(true)}
                    aria-label={`${t("header.switchCompany")}: ${supplierName}`}
                  >
                    {companyChip}
                    <Icon name="chevronDown" size={16} />
                  </button>
                ) : (
                  <span className="sidebar-company__name">{companyChip}</span>
                )}
              </div>
            </div>
          }
          footer={
            <span className="sidebar-member">
              <Icon name="user" size={20} />
              <span className="sidebar-member__name">{memberName}</span>
            </span>
          }
        />
      </div>

      <div className="shell__main" {...toastArea}>
        <header className="topbar">
          {morePages.includes(route) && (
            <IconButton
              className="topbar__back"
              icon="arrowLeft"
              label={t("common.back")}
              onClick={() => goBackTo("more")}
            />
          )}
          {canSwitch ? (
            <button
              type="button"
              className="company-chip company-chip--button"
              onClick={() => setSwitching(true)}
              aria-label={`${t("header.switchCompany")}: ${supplierName}`}
            >
              <Icon name="store" size={20} />
              {companyChip}
              <Icon name="chevronDown" size={16} />
            </button>
          ) : (
            <span className="company-chip">
              <Icon name="store" size={20} />
              {companyChip}
            </span>
          )}
        </header>

        <div className="shell__banners">
          {!online && (
            <Banner icon="wifiOff" placement="flush">
              {t("common.offline")}
            </Banner>
          )}
          {updated && (
            <Banner
              icon="refresh"
              placement="flush"
              action={
                <Button variant="text" size="s" onClick={() => window.location.reload()}>
                  {t("app.reload")}
                </Button>
              }
            >
              {t("app.updated")}
            </Banner>
          )}
          {banners.map((banner) => (
            <Banner key={banner.kind} tone={banner.tone} placement="flush">
              {t(banner.text)}
            </Banner>
          ))}
        </div>

        {/* A page taking the place of another fades in (D-069); the header, the tabs
            and the side menu stay. Another company remounts the page entirely. */}
        <FadeSwap
          as="main"
          className="page"
          key={cabinet?.generation ?? "offline"}
          fadeKey={routeId ? route + "/" + routeId : route}
        >
          {children}
        </FadeSwap>
      </div>

      <div className="shell__tabs">
        <BottomTabs<StaticRoute>
          label={t("nav.label")}
          items={tabs}
          active={tabOf(route)}
          onSelect={(key) => navigate(key)}
          center={{ key: "scan", label: t("tabs.scan"), icon: "scan", href: routePaths.scan }}
        />
      </div>

      {cabinet && (
        <CompanySwitchDialog
          open={switching}
          onClose={() => setSwitching(false)}
          companies={cabinet.companies}
        />
      )}
    </div>
  );
}
