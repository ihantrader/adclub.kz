import { isApiError } from "@adclub/api-client";
import { languages, translate, type Lang } from "@adclub/i18n";
import { Button, colors } from "@adclub/ui";
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
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "24px", maxWidth: "480px" }}>
      <h1>adclub.kz — {translate(lang, "common.appWorking")}</h1>
      <p>Supplier cabinet scaffold, version {APP_VERSION}.</p>

      {updateRequiredMessage !== null && (
        <section
          role="alert"
          style={{ border: `2px solid ${colors.danger}`, borderRadius: "8px", padding: "16px" }}
        >
          <h2 style={{ fontSize: "18px", marginTop: 0, color: colors.danger }}>
            {translate(lang, "update.title")}
          </h2>
          <p>{updateRequiredMessage}</p>
          <Button onClick={() => window.location.reload()}>
            {translate(lang, "update.reloadPage")}
          </Button>
        </section>
      )}

      <p style={{ color: connection === "failed" ? colors.danger : colors.primary }}>
        {connectionText}
      </p>
      {connection === "failed" && (
        <Button
          variant="neutral"
          onClick={() => {
            setConnection("checking");
            setRefreshToken((token) => token + 1);
          }}
        >
          {translate(lang, "common.retry")}
        </Button>
      )}

      <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
        {languages.map((candidate) => (
          <Button
            key={candidate}
            variant={candidate === lang ? "primary" : "neutral"}
            onClick={() => setLang(candidate)}
          >
            {candidate.toUpperCase()}
          </Button>
        ))}
      </div>
    </main>
  );
}
