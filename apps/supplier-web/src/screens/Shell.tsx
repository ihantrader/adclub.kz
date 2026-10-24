import {
  Banner,
  BottomTabs,
  cx,
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
import { PageHeaderProvider, type ChildHeader } from "./PageHeader";
import { companyBanners } from "../cabinet/company-state";
import type { CabinetState } from "../cabinet/cabinet-store";
import { useOnline } from "@adclub/web-session";
import { useT } from "../i18n";
import { refreshModerationUnseen, useModerationUnseen } from "../moderation/unseen";
import { refreshNewOrders, useNewOrders, useVisiblePoll } from "../orders/live";
import { useInstallWay } from "../pwa/install";
import { useAppUpdated } from "../pwa/service-worker";
import {
  menuOf,
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
/** How often the counter of «Модерация» is asked while the page is visible. */
const MODERATION_POLL_MS = 60_000;

export interface ShellProps {
  route: RouteKey;
  /** The loaded cabinet, or what the header knew last time (opened without a network). */
  cabinet: Ready | null;
  fallbackNames?: { supplierName: string; memberName: string } | null;
  children: ReactNode;
}

/**
 * The frame of every page (SCREENS 3.2, 6.0): the company in the header
 * always; on a phone — bottom tabs «Заявки · Предложения · Сканер · Прайс ·
 * Ещё» («Прайс» — stage C, TASK-046); from 1024 px — the side menu (DESIGN 7.5).
 * Banners above every page: no network, a new version, the company's state.
 */
export function Shell({ route, cabinet, fallbackNames, children }: ShellProps) {
  const t = useT();
  const online = useOnline();
  const updated = useAppUpdated();
  const installWay = useInstallWay();
  const [switching, setSwitching] = useState(false);
  const [header, setHeader] = useState<ChildHeader | null>(null);
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
  // «Модерация» (TASK-048): the decisions this employee hasn't seen, asked on every page.
  const unseen = useModerationUnseen(generation);
  useEffect(() => {
    if (generation !== null) void refreshModerationUnseen(generation);
  }, [generation, route]);
  useVisiblePoll(
    () => {
      if (generation !== null) void refreshModerationUnseen(generation);
    },
    MODERATION_POLL_MS,
    generation !== null,
  );
  const unseenCount = unseen !== null && unseen > 0 ? unseen : null;
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
    { key: "price", label: t("tabs.price"), icon: "table", href: routePaths.price },
    {
      key: "more",
      label: t("tabs.more"),
      icon: "dots",
      href: routePaths.more,
      ...(unseenCount !== null && {
        count: unseenCount,
        countLabel: t("moderation.badgeLabel", { n: unseenCount }),
      }),
    },
  ];
  // The desktop menu lists the sections of «Ещё» directly (design/mockups/supplier.html),
  // in the order of the tabs and of «Ещё» (TASK-079).
  const menu: NavItem<StaticRoute>[] = [
    ordersItem,
    { key: "offers", label: t("tabs.offers"), icon: "tags", href: routePaths.offers },
    { key: "scan", label: t("tabs.scan"), icon: "scan", href: routePaths.scan },
    { key: "price", label: t("tabs.price"), icon: "table", href: routePaths.price },
    {
      key: "moderation",
      label: t("nav.moderation"),
      icon: "checklist",
      href: routePaths.moderation,
      ...(unseenCount !== null && {
        count: unseenCount,
        countLabel: t("moderation.badgeLabel", { n: unseenCount }),
      }),
    },
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
            // The employee's name opens «Мои настройки» (it looked like an item and did nothing).
            <a
              className="sidebar-member"
              href={routePaths.settings}
              aria-current={route === "settings" ? "page" : undefined}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                navigate("settings");
              }}
            >
              <Icon name="user" size={20} />
              <span className="sidebar-member__name">{memberName}</span>
            </a>
          }
        />
      </div>

      <div className="shell__main" {...toastArea}>
        <header
          className={cx(
            "topbar",
            // The company is in the side menu from 1024 (C14): the bar stays only for «назад».
            (!header || header.deskRoot) && "topbar--phone",
          )}
        >
          {header ? (
            <>
              <IconButton
                className="topbar__back"
                icon="arrowLeft"
                label={t("common.back")}
                onClick={header.back}
              />
              <h1 className="ac-text-title topbar__title">{header.title}</h1>
              <span className="topbar__company" title={supplierName}>
                {supplierName}
              </span>
            </>
          ) : canSwitch ? (
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
        <PageHeaderProvider value={setHeader}>
          <FadeSwap
            as="main"
            className="page"
            key={cabinet?.generation ?? "offline"}
            fadeKey={routeId ? route + "/" + routeId : route}
          >
            {children}
          </FadeSwap>
        </PageHeaderProvider>
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
