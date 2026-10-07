import { isApiError } from "@adclub/api-client";
import {
  DelayedSkeleton,
  FadeSwap,
  ScreenError,
  SkeletonList,
  useDelayedIndicator,
} from "@adclub/ui";
import { useEffect, useRef, type ReactNode } from "react";
import { session, useSessionState, useUpdateRequiredMessage } from "./api";
import {
  clearCabinet,
  loadCabinet,
  refreshCompany,
  useCabinet,
  type CabinetState,
} from "./cabinet/cabinet-store";
import { applyDefaultNotificationLanguage } from "./cabinet/notification-language";
import { ItemSearch } from "./offers/ItemSearch";
import { NewOfferScreen, OfferCardScreen } from "./offers/OfferScreen";
import { OffersList } from "./offers/OffersList";
import { OrderCardScreen } from "./orders/OrderScreen";
import { OrdersList } from "./orders/OrdersList";
import { Scanner } from "./scan/Scanner";
import { subscribeOnline, isOnline } from "@adclub/web-session";
import { useLanguage, useT } from "./i18n";
import { forgetPerson, installOffered, lastKnown, markInstallOffered } from "./prefs";
import { offerInstallNow, useInstallOfferedNow, useInstallWay } from "./pwa/install";
import { navigate, useRoute, type RouteKey } from "./router";
import { AuthLayout } from "./screens/AuthLayout";
import { Company } from "./screens/Company";
import { Install } from "./screens/Install";
import { More } from "./screens/More";
import { Settings } from "./screens/Settings";
import { Shell } from "./screens/Shell";
import { SignIn } from "./screens/SignIn";
import { Starting, Unreachable } from "./screens/Starting";
import { Team } from "./screens/Team";
import { UpdateRequired } from "./screens/UpdateRequired";

type Ready = Extract<CabinetState, { status: "ready" }>;

/** The club's time zone, for the scanner opened before the company is known (no network). */
const CLUB_TIME_ZONE = "Asia/Almaty";

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

  // The screens of the page take each other's place with a fade (D-069):
  // the start, the sign-in, the cabinet. Within the cabinet the pages fade
  // by themselves (Shell), so the frame is one screen here.
  const [kind, screen] = view();
  return <FadeSwap fadeKey={kind}>{screen}</FadeSwap>;

  function view(): [string, ReactNode] {
    if (updateMessage !== null) return ["update", <UpdateRequired message={updateMessage} />];

    switch (state.status) {
      case "starting":
        return ["starting", <Starting />];
      case "signed_out":
        return [
          "sign-in",
          <SignIn
            reason={state.reason}
            onSignedIn={() => {
              signedInHere.current = true;
            }}
          />,
        ];
      case "unreachable": {
        // Opened without a network: the shell with what the header knew, if anything.
        const known = lastKnown();
        if (!known) return ["unreachable", <Unreachable onRetry={() => session.start()} />];
        return [
          "cabinet",
          <Shell route={route} cabinet={null} fallbackNames={known}>
            <Page route={route} cabinet={null} />
          </Shell>,
        ];
      }
      case "signed_in":
        if (cabinet.status === "ready") {
          return [
            "cabinet",
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
            </Shell>,
          ];
        }
        if (cabinet.status === "failed") return ["failed", <CabinetFailed error={cabinet.error} />];
        if (cabinet.status === "loading" && cabinet.switchingTo) {
          // Another company: the frame stays, the page fades into its loading state.
          return [
            "cabinet",
            <Shell route={route} cabinet={null} fallbackNames={cabinet.switchingTo}>
              <SwitchingCompany />
            </Shell>,
          ];
        }
        return ["starting", <Starting />];
    }
  }
}

/** The page while another company loads: its skeleton after the delay, nothing of the previous one. */
function SwitchingCompany() {
  const t = useT();
  const indicator = useDelayedIndicator(true);
  return (
    <DelayedSkeleton indicator={indicator}>
      <SkeletonList rows={3} label={t("common.loading")} />
    </DelayedSkeleton>
  );
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
    case "scan":
      // Without a network the scanner still opens: it says T-SCAN-01 itself.
      return (
        <Scanner
          companyName={cabinet?.company.supplier.name ?? lastKnown()?.supplierName ?? ""}
          timeZone={cabinet?.company.company.timeZone ?? CLUB_TIME_ZONE}
        />
      );
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
  const card = cabinet.company.company;
  switch (route) {
    case "orders":
      return (
        <OrdersList
          generation={cabinet.generation}
          timeZone={card.timeZone}
          blocked={card.state === "blocked"}
        />
      );
    case "order":
      return <OrderCardScreen timeZone={card.timeZone} blocked={card.state === "blocked"} />;
    case "settings":
      return <Settings cabinet={cabinet} />;
    case "team":
      return <Team />;
    case "offers":
      return <OffersList />;
    case "offerSearch":
      return <ItemSearch />;
    case "offerNew":
      return <NewOfferScreen company={cabinet.company.company} />;
    case "offer":
      return <OfferCardScreen company={cabinet.company.company} />;
    default:
      return <Company cabinet={cabinet} />;
  }
}
