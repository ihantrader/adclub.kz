import type { CurrentAccountResponse } from "@adclub/contracts";
import { FadeSwap } from "@adclub/ui";
import { isOnline, subscribeOnline } from "@adclub/web-session";
import { useEffect, useState, type ReactNode } from "react";
import { apiClient, session, useSessionState, useUpdateRequiredMessage } from "./api";
import { Audit } from "./audit/Audit";
import { Home } from "./home/Home";
import { comingSections, useRoute, type RouteKey } from "./router";
import { Coming } from "./screens/Coming";
import { Shell } from "./screens/Shell";
import { SignIn } from "./screens/SignIn";
import { NarrowNotice, Starting, Unreachable, UpdateRequired } from "./screens/Starting";
import { Security } from "./security/Security";
import { Cities } from "./settings/Cities";
import { ClientPolicy } from "./settings/ClientPolicy";
import { SettingHistory } from "./settings/SettingHistory";
import { Thresholds } from "./settings/Thresholds";
import { Signals } from "./signals/Signals";

/**
 * The admin panel (TASK-034): which screen the page shows follows only from
 * the server's answers — «нужно обновить», the session (found out by the
 * cookie exchange when the page opens, ARCHITECTURE 4.47, 4.52), then the
 * page of the address. The sign-in is shown over the requested page and
 * leaves the administrator on it.
 */
export function App() {
  const updateMessage = useUpdateRequiredMessage();
  const state = useSessionState();
  const route = useRoute();
  const [account, setAccount] = useState<{
    sessionId: string;
    me: CurrentAccountResponse;
  } | null>(null);

  useEffect(() => {
    void session.start();
  }, []);

  // Who is signed in: for the header. It belongs to its session and goes with it.
  const sessionId = state.status === "signed_in" ? state.tokens.sessionId : null;
  const me = account && account.sessionId === sessionId ? account.me : null;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    apiClient.getCurrentAccount().then(
      (answer) => {
        if (!cancelled) setAccount({ sessionId, me: answer });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // The network back, or the page back on screen: find out again what failed.
  useEffect(() => {
    const retry = () => {
      if (session.state().status === "unreachable") void session.start();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const unsubscribe = subscribeOnline(() => {
      if (isOnline()) retry();
    });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const [kind, screen] = view();
  return (
    <div className="admin-root">
      <div className="desk-only">
        {/* The start, the sign-in and the admin panel take each other's place with a fade (D-069). */}
        <FadeSwap fadeKey={kind}>{screen}</FadeSwap>
      </div>
      <NarrowNotice />
    </div>
  );

  function view(): [string, ReactNode] {
    if (updateMessage !== null) return ["update", <UpdateRequired message={updateMessage} />];
    switch (state.status) {
      case "starting":
        return ["starting", <Starting />];
      case "signed_out":
        return ["sign-in", <SignIn reason={state.reason} />];
      case "unreachable":
        return ["unreachable", <Unreachable onRetry={() => session.start()} />];
      case "signed_in":
        return [
          "admin",
          <Shell route={route} me={me}>
            <Page route={route} me={me} />
          </Shell>,
        ];
    }
  }
}

function Page({ route, me }: { route: RouteKey; me: CurrentAccountResponse | null }) {
  switch (route) {
    case "signals":
      return <Signals />;
    case "settings":
      return <Thresholds />;
    case "settingHistory":
      return <SettingHistory />;
    case "clientPolicy":
      return <ClientPolicy />;
    case "cities":
      return <Cities />;
    case "audit":
      return <Audit />;
    case "security":
      return (
        <Security currentAdminId={me?.access.context === "admin" ? me.access.admin.id : null} />
      );
    case "catalog":
      return <Coming title="Справочник" icon="category" task={comingSections.catalog!} />;
    case "vehicles":
      return <Coming title="Автомобили" icon="car" task={comingSections.vehicles!} />;
    case "suppliers":
      return <Coming title="Поставщики" icon="store" task={comingSections.suppliers!} />;
    case "orders":
      return <Coming title="Заявки" icon="receipt" task={comingSections.orders!} />;
    case "users":
      return <Coming title="Пользователи" icon="users" task={comingSections.users!} />;
    default:
      return <Home />;
  }
}
