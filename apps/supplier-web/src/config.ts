/** `version` from this app's package.json, injected by `vite.config.ts`. */
export const APP_VERSION = __APP_VERSION__;

/** Port of the API in development; over HTTPS — the TLS proxy of `pnpm dev:lan` (CLAUDE.md 0). */
export const DEV_API_PORT = { http: 3000, https: 3443 } as const;

/**
 * Where the API is when the build doesn't say (`VITE_API_URL`): the same
 * host as the page, on the API's development port. A page opened as
 * `http://localhost:5175` talks to `http://localhost:3000`; the cabinet
 * served by `pnpm dev:lan` at `https://192.168.1.5:5443` talks to
 * `https://192.168.1.5:3443` — the same site, so the session cookie
 * (`SameSite=Strict`) reaches it. A production build always sets
 * `VITE_API_URL`.
 */
export function defaultApiUrl(location: { protocol: string; hostname: string }): string {
  const https = location.protocol === "https:";
  const host = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname;
  return `${https ? "https" : "http"}://${host}:${https ? DEV_API_PORT.https : DEV_API_PORT.http}`;
}

export const API_URL: string =
  import.meta.env.VITE_API_URL ??
  (typeof window === "undefined" ? "http://localhost:3000" : defaultApiUrl(window.location));
