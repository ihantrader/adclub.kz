import { isApiError } from "@adclub/api-client";
import type { CurrentAccountResponse } from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  FadeSwap,
  Icon,
  Logo,
  Segments,
  Sidebar,
  toastArea,
  useTheme,
  type NavItem,
} from "@adclub/ui";
import type { ThemeMode } from "@adclub/ui-core";
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
import { BACKUP_CODES_LOW, useBackupCodesRemaining } from "../security/backup-reminder";

const MENU: NavItem<StaticRoute>[] = [
  { key: "home", label: "Главная", icon: "checklist", href: routePaths.home },
  { key: "signals", label: "Сигналы", icon: "alertTriangle", href: routePaths.signals },
  { key: "settings", label: "Настройки", icon: "settings", href: routePaths.settings },
  { key: "audit", label: "Журнал", icon: "clock", href: routePaths.audit },
  { key: "security", label: "Безопасность", icon: "lock", href: routePaths.security },
];

/** The sections of TASK-035 and TASK-036, shown as such. */
const NEXT: NavItem<StaticRoute>[] = [
  { key: "catalog", label: "Справочник", icon: "category", href: routePaths.catalog },
  { key: "vehicles", label: "Автомобили", icon: "car", href: routePaths.vehicles },
  { key: "suppliers", label: "Поставщики", icon: "store", href: routePaths.suppliers },
  { key: "orders", label: "Заявки", icon: "receipt", href: routePaths.orders },
  { key: "users", label: "Пользователи", icon: "users", href: routePaths.users },
];

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
  { value: "system", label: "Как в системе" },
];

/**
 * The frame of every page (SCREENS 7.0; TASK-034 requirement 1): the side
 * menu of sections — the live ones and, below, those of the next tasks —
 * the administrator and «Выйти» in the header, the theme, the banners
 * («Нет сети», the backup codes running out). The page fades in its place
 * (D-069); the frame stays.
 */
export function Shell({
  route,
  me,
  children,
}: {
  route: RouteKey;
  me: CurrentAccountResponse | null;
  children: ReactNode;
}) {
  const online = useOnline();
  const { mode, setMode } = useTheme();
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
          items={[...MENU, ...NEXT]}
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
          <div className="topbar__who">
            <Icon name="user" size={20} />
            <span className="topbar__name">{who}</span>
            {phone && <span className="ac-text-body-s ac-muted num">{phone}</span>}
          </div>
          <div className="topbar__actions">
            <Segments<ThemeMode> label="Тема" options={THEMES} value={mode} onChange={setMode} />
            <Button
              variant="secondary"
              size="s"
              icon="logout"
              disabled={!online}
              onClick={() => setLeaving(true)}
            >
              Выйти
            </Button>
          </div>
        </header>

        <div className="shell__banners">
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
