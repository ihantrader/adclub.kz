import { isApiError } from "@adclub/api-client";
import type { HealthCheckResponse, ReadinessResponse } from "@adclub/contracts";
import { translate } from "@adclub/i18n";
import { Badge, Banner, Button, Logo, Spinner } from "@adclub/ui";
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
    <section role="alert" className="service-page__stack">
      <h2 className="ac-text-title">{translate("ru", "update.title")}</h2>
      <Banner tone="warning">{message}</Banner>
      <Button size="l" icon="refresh" onClick={() => window.location.reload()}>
        {translate("ru", "update.reloadPage")}
      </Button>
    </section>
  );
}

function Checking() {
  return (
    <div className="service-page__status">
      <Spinner />
      <span>{translate("ru", "connection.checking")}</span>
    </div>
  );
}

export function App() {
  const updateRequiredMessage = useUpdateRequiredMessage();
  const [health, reloadHealth] = useLoad<HealthCheckResponse>(apiClient.getHealth);
  const [readiness, reloadReadiness] = useLoad<ReadinessResponse>(apiClient.getReadiness);

  return (
    <main className="service-page">
      <Logo height={48} />
      <h1 className="ac-text-title-l">{translate("ru", "common.appWorking")}</h1>
      <p className="ac-text-body-s ac-muted">
        Admin panel scaffold, version {APP_VERSION}. API: {API_URL}
      </p>

      {updateRequiredMessage !== null && <UpdateRequiredNotice message={updateRequiredMessage} />}

      <section className="service-page__stack">
        <h2 className="ac-text-heading">API health</h2>
        {health.status === "loading" && <Checking />}
        {health.status === "success" && (
          <Badge tone="success" icon="circleCheck">
            {health.data.service}: {health.data.status} at {health.data.timestamp}
          </Badge>
        )}
        {health.status === "error" && (
          <Badge tone="danger" icon="alertTriangle">
            {health.message}
          </Badge>
        )}
      </section>

      <section className="service-page__stack">
        <h2 className="ac-text-heading">Dependencies</h2>
        {readiness.status === "loading" && <Checking />}
        {readiness.status === "success" && (
          <ul className="service-page__list">
            {Object.entries(readiness.data.checks).map(([name, check]) => (
              <li key={name}>
                <Badge
                  tone={check.status === "ok" ? "success" : "danger"}
                  icon={check.status === "ok" ? "circleCheck" : "alertTriangle"}
                >
                  {name}: {check.status}
                  {check.error ? ` (${check.error})` : ""}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {readiness.status === "error" && (
          <Badge tone="danger" icon="alertTriangle">
            {readiness.message}
          </Badge>
        )}
      </section>

      <Button
        variant="secondary"
        icon="refresh"
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
