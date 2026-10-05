import { isApiError } from "@adclub/api-client";
import { ScreenError } from "@adclub/ui";
import { useEffect, useRef } from "react";
import { session, useSessionState, useUpdateRequiredMessage } from "./api";
import {
  clearCabinet,
  loadCabinet,
  refreshCompany,
  useCabinet,
  type CabinetState,
} from "./cabinet/cabinet-store";
import { applyDefaultNotificationLanguage } from "./cabinet/notification-language";
import { subscribeOnline, isOnline } from "./connection";
import { useLanguage, useT } from "./i18n";
import { forgetPerson, installOffered, lastKnown, markInstallOffered } from "./prefs";
import { offerInstallNow, useInstallOfferedNow, useInstallWay } from "./pwa/install";
import { navigate, useRoute, type RouteKey } from "./router";
import { AuthLayout } from "./screens/AuthLayout";
import { Company } from "./screens/Company";
import { Install } from "./screens/Install";
import { More } from "./screens/More";
import { SectionPlaceholder } from "./screens/SectionPlaceholder";
import { Settings } from "./screens/Settings";
import { Shell } from "./screens/Shell";
import { SignIn } from "./screens/SignIn";
import { Starting, Unreachable } from "./screens/Starting";
import { Team } from "./screens/Team";
import { UpdateRequired } from "./screens/UpdateRequired";

type Ready = Extract<CabinetState, { status: "ready" }>;

/** How often an open cabinet re-reads the company's state (a pause, a block) while visible. */
const COMPANY_REFRESH_MS = 5 * 60_000;

/**
 * The supplier cabinet (TASK-031): which screen the page shows follows only
 * from the server's answers — «нужно обновить», the session (found out by
 * the cookie exchange when the page opens), and the company of the session.
 */
export function App() {
  const updateMessage = useUpdateRequiredMessage();
  const state = useSessionState();
  const cabinet = useCabinet();
  const route = useRoute();
  const { lang } = useLanguage();
  const installWay = useInstallWay();
  const offerInstall = useInstallOfferedNow();
  /** A sign-in finished on this page (not a session found by the cookie). */
  const signedInHere = useRef(false);

  useEffect(() => {
    if (window.location.pathname === "/") navigate("orders", { replace: true });
    void session.start();
  }, []);

  // The session decides what is loaded and what is forgotten.
  useEffect(() => {
    if (state.status === "signed_in" && cabinet.status === "idle") void loadCabinet();
    if (state.status === "signed_out") {
      if (cabinet.status !== "idle") clearCabinet();
      forgetPerson();
    }
  }, [state.status, cabinet.status]);

  // After a sign-in on this page: the notification language follows the
  // interface (SCREENS 6.0), and S-INST-01 is offered once.
  useEffect(() => {
    if (!signedInHere.current || cabinet.status !== "ready") return;
    signedInHere.current = false;
    void applyDefaultNotificationLanguage(lang);
    if (!installOffered() && installWay !== "installed") {
      markInstallOffered();
      offerInstallNow(true);
      navigate("install");
    }
  }, [cabinet.status, lang, installWay]);

  // The network back, the page back on screen: find out again what failed,
  // and re-read the company (its state can change any time).
  useEffect(() => {
    const retry = () => {
      const now = session.state();
      if (now.status === "unreachable") void session.start();
      else if (now.status === "signed_in") void loadCabinet();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      retry();
      void refreshCompany();
    };
    const unsubscribe = subscribeOnline(() => {
      if (isOnline()) retry();
    });
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshCompany();
    }, COMPANY_REFRESH_MS);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  if (updateMessage !== null) return <UpdateRequired message={updateMessage} />;

  switch (state.status) {
    case "starting":
      return <Starting />;
    case "signed_out":
      return (
        <SignIn
          reason={state.reason}
          onSignedIn={() => {
            signedInHere.current = true;
          }}
        />
      );
    case "unreachable": {
      // Opened without a network: the shell with what the header knew, if anything.
      const known = lastKnown();
      if (!known) return <Unreachable onRetry={() => session.start()} />;
      return (
        <Shell route={route} cabinet={null} fallbackNames={known}>
          <Page route={route} cabinet={null} />
        </Shell>
      );
    }
    case "signed_in":
      if (cabinet.status === "ready") {
        return (
          <Shell route={route} cabinet={cabinet}>
            <Page
              route={route}
              cabinet={cabinet}
              firstInstall={offerInstall}
              onInstallDone={() => {
                offerInstallNow(false);
                navigate("orders", { replace: true });
              }}
            />
          </Shell>
        );
      }
      if (cabinet.status === "failed") return <CabinetFailed error={cabinet.error} />;
      return <Starting />;
  }
}

function CabinetFailed({ error }: { error: unknown }) {
  const t = useT();
  const offline = isApiError(error) && error.code === "NETWORK_ERROR";
  return (
    <AuthLayout>
      <ScreenError
        title={offline ? t("common.offline") : t("common.errorTitle")}
        text={t("common.errorText")}
        retry={{ label: t("common.retry"), onRetry: () => loadCabinet() }}
      />
    </AuthLayout>
  );
}

function Page({
  route,
  cabinet,
  firstInstall = false,
  onInstallDone,
}: {
  route: RouteKey;
  cabinet: Ready | null;
  firstInstall?: boolean;
  onInstallDone?: () => void;
}) {
  const t = useT();
  switch (route) {
    case "orders":
      return <SectionPlaceholder title={t("tabs.orders")} icon="receipt" />;
    case "offers":
      return <SectionPlaceholder title={t("tabs.offers")} icon="tags" />;
    case "scan":
      return <SectionPlaceholder title={t("tabs.scan")} icon="scan" />;
    case "more":
      return <More />;
    case "install":
      return <Install firstTime={firstInstall} onDone={firstInstall ? onInstallDone : undefined} />;
    default:
      break;
  }
  // The rest needs the server: without a network there is nothing to show yet.
  if (!cabinet) {
    return (
      <ScreenError
        title={t("common.offline")}
        text={t("common.errorText")}
        retry={{ label: t("common.retry"), onRetry: () => session.start() }}
      />
    );
  }
  switch (route) {
    case "settings":
      return <Settings cabinet={cabinet} />;
    case "team":
      return <Team />;
    default:
      return <Company cabinet={cabinet} />;
  }
}
