import { isApiError } from "@adclub/api-client";
import type { CurrentAccountResponse } from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  FadeSwap,
  MenuButton,
  Logo,
  Sidebar,
  toastArea,
  type NavItem,
} from "@adclub/ui";
import { formatPhone, useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient, session } from "../api";
import {
  menuOf,
  navigate,
  routePaths,
  useLocation,
  type RouteKey,
  type StaticRoute,
} from "../router";
import { HeaderSearch } from "../search/HeaderSearch";
import { BACKUP_CODES_LOW, useBackupCodesRemaining } from "../security/backup-reminder";

const MENU: NavItem<StaticRoute>[] = [
  { key: "home", label: "Главная", icon: "checklist", href: routePaths.home },
  { key: "signals", label: "Сигналы", icon: "alertTriangle", href: routePaths.signals },
  { key: "catalog", label: "Справочник", icon: "category", href: routePaths.catalog },
  { key: "vehicles", label: "Автомобили", icon: "car", href: routePaths.vehicles },
  { key: "orders", label: "Заявки", icon: "receipt", href: routePaths.orders },
  { key: "users", label: "Пользователи", icon: "users", href: routePaths.users },
  { key: "reviews", label: "Отзывы и жалобы", icon: "star", href: routePaths.reviews },
  { key: "suppliers", label: "Поставщики", icon: "store", href: routePaths.suppliers },
  { key: "settings", label: "Настройки", icon: "settings", href: routePaths.settings },
  { key: "audit", label: "Журнал", icon: "clock", href: routePaths.audit },
  { key: "security", label: "Безопасность", icon: "lock", href: routePaths.security },
];

/**
 * The frame of every page (SCREENS 7.0; TASK-034 requirement 1): the side
 * menu of sections — the live ones and, below, those of the next tasks —
 * the administrator and «Выйти» in the header, the banners
 * («Нет сети», the backup codes running out). The page fades in its place
 * (D-069); the frame stays.
 */
export function Shell({
  route,
  me,
  connection,
  children,
}: {
  route: RouteKey;
  me: CurrentAccountResponse | null;
  /** The connection lost after the page was shown (X29): a banner over the last content. */
  connection?: ReactNode;
  children: ReactNode;
}) {
  const online = useOnline();
  const remaining = useBackupCodesRemaining();
  const location = useLocation();
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const who = me ? (me.account.name ?? formatPhone(me.account.phone)) : "";
  const phone = me && me.account.name ? formatPhone(me.account.phone) : null;

  const signOut = async () => {
    setLeaveError(null);
    try {
      await apiClient.logout();
    } catch (thrown) {
      // The session is already over — that is what was asked for.
      const over =
        isApiError(thrown) && (thrown.code === "SESSION_ENDED" || thrown.code === "AUTH_REQUIRED");
      if (!over) {
        setLeaveError("Не удалось выйти: нет связи с сервером. Попробуйте ещё раз");
        return;
      }
    }
    session.signOut("none");
  };

  return (
    <div className="shell">
      <div className="shell__sidebar">
        <Sidebar<StaticRoute>
          label="Разделы админки"
          items={MENU}
          active={menuOf(route)}
          onSelect={(key) => navigate(key)}
          header={
            <div className="sidebar-head">
              <Logo height={32} />
              <span className="ac-text-caption ac-muted">Админка клуба</span>
            </div>
          }
        />
      </div>

      <div className="shell__main" {...toastArea}>
        <header className="topbar">
          <div className="topbar__inner">
            <HeaderSearch />
            <MenuButton
              text={who || "Администратор клуба"}
              label={`Администратор клуба${who ? `: ${who}` : ""}${phone ? `, ${phone}` : ""}`}
              actions={[
                {
                  key: "security",
                  label: "Безопасность и резервные коды",
                  icon: "lock",
                  onSelect: () => navigate("security"),
                },
                {
                  key: "logout",
                  label: "Выйти",
                  icon: "logout",
                  disabled: !online,
                  onSelect: () => setLeaving(true),
                },
              ]}
            />
          </div>
        </header>

        <div className="shell__banners">
          {connection}
          {!online && (
            <Banner icon="wifiOff" placement="flush">
              Нет сети. Изменения сохранить нельзя — повторите, когда связь вернётся.
            </Banner>
          )}
          {remaining !== null && remaining <= BACKUP_CODES_LOW && (
            <Banner
              tone="warning"
              placement="flush"
              action={
                route !== "security" ? (
                  <Button variant="text" size="s" onClick={() => navigate("security")}>
                    Новые резервные коды
                  </Button>
                ) : undefined
              }
            >
              {remaining === 0
                ? "Резервные коды закончились. Создайте новые в разделе «Безопасность»."
                : `Осталось резервных кодов: ${remaining}. Создайте новые в разделе «Безопасность».`}
            </Banner>
          )}
        </div>

        <FadeSwap as="main" className="page" fadeKey={`${route}/${location.id ?? ""}`}>
          {children}
        </FadeSwap>
      </div>

      <Dialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Выйти из админки?"
        actions={
          <>
            <Button onClick={signOut}>Выйти</Button>
            <Button variant="secondary" onClick={() => setLeaving(false)}>
              Остаться
            </Button>
          </>
        }
      >
        Чтобы войти снова, понадобятся код из WhatsApp и код приложения-аутентификатора.
        {leaveError && <p className="dialog-error">{leaveError}</p>}
      </Dialog>
    </div>
  );
}
