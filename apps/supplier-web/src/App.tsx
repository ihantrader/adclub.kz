import { isApiError } from "@adclub/api-client";
import { languages, translate, type Lang } from "@adclub/i18n";
import { Badge, Banner, Button, Logo, Segments, Spinner } from "@adclub/ui";
import { useEffect, useState } from "react";
import { APP_VERSION, apiClient, setApiLanguage, useUpdateRequiredMessage } from "./api";

type Connection = "checking" | "ok" | "failed";

export function App() {
  const [lang, setLang] = useState<Lang>("ru");
  const [connection, setConnection] = useState<Connection>("checking");
  const [refreshToken, setRefreshToken] = useState(0);
  const updateRequiredMessage = useUpdateRequiredMessage();

  useEffect(() => {
    setApiLanguage(lang);
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    let cancelled = false;
    // Readiness is a version-enforced route: an outdated build learns here
    // that it must be reloaded (health is always served, so it can't).
    apiClient
      .getReadiness()
      .then(() => {
        if (!cancelled) setConnection("ok");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setConnection(isApiError(error) && error.code !== "NETWORK_ERROR" ? "ok" : "failed");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const connectionText = {
    checking: translate(lang, "connection.checking"),
    ok: translate(lang, "connection.ok"),
    failed: translate(lang, "connection.failed"),
  }[connection];

  return (
    <main className="service-page">
      <Logo height={48} />
      <h1 className="ac-text-title-l">{translate(lang, "common.appWorking")}</h1>
      <p className="ac-text-body-s ac-muted">Supplier cabinet scaffold, version {APP_VERSION}.</p>

      {updateRequiredMessage !== null && (
        <section role="alert" className="service-page__stack">
          <h2 className="ac-text-title">{translate(lang, "update.title")}</h2>
          <Banner tone="warning">{updateRequiredMessage}</Banner>
          <Button size="l" icon="refresh" onClick={() => window.location.reload()}>
            {translate(lang, "update.reloadPage")}
          </Button>
        </section>
      )}

      <div className="service-page__status" aria-live="polite">
        {connection === "checking" && (
          <>
            <Spinner />
            <span>{connectionText}</span>
          </>
        )}
        {connection === "ok" && (
          <Badge tone="success" icon="circleCheck">
            {connectionText}
          </Badge>
        )}
        {connection === "failed" && (
          <Badge tone="danger" icon="wifiOff">
            {connectionText}
          </Badge>
        )}
      </div>
      {connection === "failed" && (
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => {
            setConnection("checking");
            setRefreshToken((token) => token + 1);
          }}
        >
          {translate(lang, "common.retry")}
        </Button>
      )}

      <Segments<Lang>
        label="Language"
        value={lang}
        onChange={setLang}
        options={languages.map((candidate) => ({
          value: candidate,
          label: candidate.toUpperCase(),
        }))}
      />
    </main>
  );
}
