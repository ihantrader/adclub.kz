import { Button, colors } from "@adclub/ui";
import { healthCheckResponseSchema, type HealthCheckResponse } from "@adclub/contracts";
import { translate } from "@adclub/i18n";
import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type State =
  | { status: "loading" }
  | { status: "success"; data: HealthCheckResponse }
  | { status: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);
  const checkHealth = () => {
    setState({ status: "loading" });
    setRefreshToken((token) => token + 1);
  };

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_URL}/health`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Server responded with ${res.status}`);
        }
        const json: unknown = await res.json();
        const data = healthCheckResponseSchema.parse(json);
        if (!cancelled) setState({ status: "success", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "24px", maxWidth: "480px" }}>
      <h1>adclub.kz — {translate("ru", "common.appWorking")}</h1>
      <p>Admin panel scaffold (TASK-001).</p>

      <section style={{ marginTop: "16px" }}>
        <h2 style={{ fontSize: "16px" }}>API health</h2>
        {state.status === "loading" && <p>Checking {API_URL}/health…</p>}
        {state.status === "success" && (
          <p style={{ color: colors.primary }}>
            {state.data.service}: {state.data.status} at {state.data.timestamp}
          </p>
        )}
        {state.status === "error" && (
          <p style={{ color: colors.danger }}>Could not reach API: {state.message}</p>
        )}
        <Button onClick={checkHealth}>Recheck</Button>
      </section>
    </main>
  );
}
