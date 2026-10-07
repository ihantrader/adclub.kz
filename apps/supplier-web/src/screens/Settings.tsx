import { isApiError } from "@adclub/api-client";
import type { NotificationLanguage, SupplierMemberResponse } from "@adclub/contracts";
import type { ThemeMode } from "@adclub/ui-core";
import {
  Banner,
  Button,
  DelayedSkeleton,
  Dialog,
  ScreenError,
  Segments,
  SkeletonList,
  Switch,
  useLoadingGate,
  useTheme,
} from "@adclub/ui";
import { useCallback, useEffect, useState } from "react";
import { apiClient, session } from "../api";
import { clearCabinet, type CabinetState } from "../cabinet/cabinet-store";
import { formatPhone, useOnline } from "@adclub/web-session";
import { saveErrorText } from "../errors";
import { useT } from "../i18n";
import { forgetPerson, settleNotificationLanguage } from "../prefs";
import { useInstallWay } from "../pwa/install";
import { CompanyChoices } from "./CompanySwitch";
import { LanguageSwitch } from "./LanguageSwitch";
import { MenuLink } from "./More";
import { notificationNote } from "./Team";

type Ready = Extract<CabinetState, { status: "ready" }>;

/** S-TEAM-02 «Мои настройки». */
export function Settings({ cabinet }: { cabinet: Ready }) {
  const t = useT();
  const online = useOnline();
  const theme = useTheme();
  const installWay = useInstallWay();
  const [me, setMe] = useState<SupplierMemberResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const gate = useLoadingGate();
  const { begin, settle } = gate;

  // No state is set before the answer: the effect below only starts the
  // request; the answer comes through the loading rule (D-069).
  const load = useCallback(async () => {
    const ticket = begin();
    try {
      const next = await apiClient.getSupplierMe();
      settle(ticket, () => {
        setMe(next);
        setLoadError(null);
      });
    } catch (thrown) {
      settle(ticket, () => setLoadError(thrown));
    }
  }, [begin, settle]);

  useEffect(() => {
    // Loading on mount, as DevicesScreen of the app does.
    void load();
  }, [load]);

  const update = async (body: {
    notificationsEnabled?: boolean;
    notificationLanguage?: NotificationLanguage;
  }) => {
    setError(null);
    try {
      const next = await apiClient.updateSupplierMe(body);
      setMe(next);
      if (body.notificationLanguage) settleNotificationLanguage(next.member.id);
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "SUPPLIER_NOTIFICATION_LIMIT") void load();
      setError(
        isApiError(thrown) && thrown.code === "SUPPLIER_NOTIFICATION_LIMIT"
          ? t("team.limitReached", { n: me?.notifications.limit ?? "" })
          : saveErrorText(thrown, t),
      );
    }
  };

  const signOut = async () => {
    try {
      await apiClient.logout();
    } catch (thrown) {
      // The session is already over — that is what was asked for.
      const over =
        isApiError(thrown) &&
        (thrown.code === "SESSION_ENDED" ||
          thrown.code === "SUPPLIER_ACCESS_CLOSED" ||
          thrown.code === "AUTH_REQUIRED");
      if (!over) {
        setError(saveErrorText(thrown, t));
        setSigningOut(false);
        return;
      }
    }
    forgetPerson();
    clearCabinet();
    session.signOut("none");
  };

  return (
    <>
      <h1 className="ac-text-title page__title">{t("settings.title")}</h1>
      {error && <Banner tone="danger">{error}</Banner>}

      <section className="card">
        {loadError !== null && !me ? (
          <ScreenError
            title={t("common.errorTitle")}
            text={t("common.errorText")}
            retry={{ label: t("common.retry"), onRetry: load }}
          />
        ) : !me ? (
          <DelayedSkeleton indicator={gate.indicator}>
            <SkeletonList rows={2} label={t("common.loading")} />
          </DelayedSkeleton>
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>{t("settings.name")}</dt>
                <dd>{me.member.displayName}</dd>
              </div>
              <div>
                <dt>{t("settings.phone")}</dt>
                <dd className="num">{formatPhone(me.member.phone)}</dd>
              </div>
            </dl>
            <Switch
              label={t("settings.notifications")}
              description={
                notificationNote(me.member, me.notifications, t) ?? t("settings.notificationsHint")
              }
              checked={me.member.notificationsEnabled}
              disabled={!online || (!me.member.notificationsEnabled && me.notifications.full)}
              onChange={(checked) => update({ notificationsEnabled: checked })}
            />
            <div className="field-block">
              <span className="field-block__label">{t("settings.notificationLanguage")}</span>
              <Segments<NotificationLanguage>
                label={t("settings.notificationLanguage")}
                value={me.member.notificationLanguage}
                onChange={(value) => {
                  if (online) void update({ notificationLanguage: value });
                }}
                options={[
                  { value: "kk", label: t("language.kk") },
                  { value: "ru", label: t("language.ru") },
                ]}
              />
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="field-block">
          <span className="field-block__label">{t("settings.interfaceLanguage")}</span>
          <LanguageSwitch label={t("settings.interfaceLanguage")} />
        </div>
        <div className="field-block">
          <span className="field-block__label">{t("settings.theme")}</span>
          <Segments<ThemeMode>
            label={t("settings.theme")}
            value={theme.mode}
            onChange={theme.setMode}
            options={[
              { value: "light", label: t("settings.themeLight"), icon: "sun" },
              { value: "dark", label: t("settings.themeDark"), icon: "moon" },
              { value: "system", label: t("settings.themeSystem"), icon: "contrast" },
            ]}
          />
        </div>
      </section>

      {cabinet.companies.length > 1 && (
        <section className="card">
          <h2 className="ac-text-heading">{t("settings.switchCompany")}</h2>
          <CompanyChoices companies={cabinet.companies} />
        </section>
      )}

      <nav className="menu">
        {installWay !== "installed" && (
          <MenuLink route="install" icon="download" label={t("nav.install")} />
        )}
      </nav>

      <Button
        variant="secondary"
        destructive
        size="l"
        block
        icon="logout"
        disabled={!online}
        onClick={() => setSigningOut(true)}
      >
        {t("settings.signOut")}
      </Button>
      {!online && <p className="ac-text-caption ac-muted">{t("common.needNetwork")}</p>}

      <Dialog
        open={signingOut}
        onClose={() => setSigningOut(false)}
        title={t("settings.signOutConfirmTitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setSigningOut(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={signOut}>{t("settings.signOut")}</Button>
          </>
        }
      >
        {t("settings.signOutConfirmText")}
      </Dialog>
    </>
  );
}
