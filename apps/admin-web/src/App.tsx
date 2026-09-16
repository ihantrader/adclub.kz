import { isApiError } from "@adclub/api-client";
import type { HealthCheckResponse, ReadinessResponse } from "@adclub/contracts";
import { translate } from "@adclub/i18n";
import { Button, colors } from "@adclub/ui";
import { useCallback, useEffect, useState } from "react";
import { API_URL, APP_VERSION, apiClient, useUpdateRequiredMessage } from "./api";

type Loadable<T> =
  { status: "loading" } | { status: "success"; data: T } | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    return error.code === "NETWORK_ERROR" ? translate("ru", "connection.failed") : error.message;
  }
  return error instanceof Error ? error.message : "Unknown error";
}

/** `load` must be a stable reference (e.g. a method of the module-level `apiClient`). */
function useLoad<T>(load: () => Promise<T>): [Loadable<T>, () => void] {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) setState({ status: "success", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [load, refreshToken]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setRefreshToken((token) => token + 1);
  }, []);

  return [state, reload];
}

function UpdateRequiredNotice({ message }: { message: string }) {
  return (
    <section
      role="alert"
      style={{
        border: `2px solid ${colors.danger}`,
        borderRadius: "8px",
        padding: "16px",
        marginBottom: "16px",
      }}
    >
      <h2 style={{ fontSize: "18px", marginTop: 0, color: colors.danger }}>
        {translate("ru", "update.title")}
      </h2>
      <p>{message}</p>
      <Button onClick={() => window.location.reload()}>
        {translate("ru", "update.reloadPage")}
      </Button>
    </section>
  );
}

export function App() {
  const updateRequiredMessage = useUpdateRequiredMessage();
  const [health, reloadHealth] = useLoad<HealthCheckResponse>(apiClient.getHealth);
  const [readiness, reloadReadiness] = useLoad<ReadinessResponse>(apiClient.getReadiness);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "24px", maxWidth: "560px" }}>
      <h1>adclub.kz — {translate("ru", "common.appWorking")}</h1>
      <p>
        Admin panel scaffold, version {APP_VERSION}. API: {API_URL}
      </p>

      {updateRequiredMessage !== null && <UpdateRequiredNotice message={updateRequiredMessage} />}

      <section style={{ marginTop: "16px" }}>
        <h2 style={{ fontSize: "16px" }}>API health</h2>
        {health.status === "loading" && <p>{translate("ru", "connection.checking")}</p>}
        {health.status === "success" && (
          <p style={{ color: colors.primary }}>
            {health.data.service}: {health.data.status}
          </p>
        )}
        {health.status === "error" && <p style={{ color: colors.danger }}>{health.message}</p>}
      </section>

      <section style={{ marginTop: "16px" }}>
        <h2 style={{ fontSize: "16px" }}>Dependencies</h2>
        {readiness.status === "loading" && <p>{translate("ru", "connection.checking")}</p>}
        {readiness.status === "success" && (
          <ul>
            {Object.entries(readiness.data.checks).map(([name, check]) => (
              <li
                key={name}
                style={{ color: check.status === "ok" ? colors.primary : colors.danger }}
              >
                {name}: {check.status}
                {check.error ? ` (${check.error})` : ""}
              </li>
            ))}
          </ul>
        )}
        {readiness.status === "error" && (
          <p style={{ color: colors.danger }}>{readiness.message}</p>
        )}
      </section>

      <Button
        onClick={() => {
          reloadHealth();
          reloadReadiness();
        }}
        disabled={health.status === "loading" || readiness.status === "loading"}
      >
        {translate("ru", "common.retry")}
      </Button>
    </main>
  );
}
