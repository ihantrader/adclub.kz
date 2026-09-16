export const API_PORT = 3000;

/**
 * Where the app finds the API:
 * 1. `EXPO_PUBLIC_API_URL` when set (staging/production builds, or a
 *    phone that should talk to some other machine);
 * 2. in development, the machine running the Expo dev server — the phone
 *    already reaches it over Wi-Fi at `hostUri` (e.g. `192.168.1.10:8081`),
 *    and the API runs on the same machine on port 3000;
 * 3. `http://localhost:3000` as a last resort (emulator on the dev machine).
 */
export function resolveApiUrl(input: {
  explicitUrl?: string;
  devServerHostUri?: string | null;
}): string {
  const explicitUrl = input.explicitUrl?.trim();
  if (explicitUrl) {
    return explicitUrl.replace(/\/+$/, "");
  }

  const host = hostFromHostUri(input.devServerHostUri);
  return `http://${host ?? "localhost"}:${API_PORT}`;
}

/**
 * `host:port[/path]` → `host`. Parsed by hand: React Native's `URL`
 * polyfill doesn't implement `hostname` in every version.
 */
function hostFromHostUri(hostUri: string | null | undefined): string | null {
  const match = /^(\[[^\]]+\]|[^:/\s]+)/.exec(hostUri?.trim() ?? "");
  return match?.[1] ?? null;
}
