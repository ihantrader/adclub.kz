import { createWebClient, defaultApiUrl } from "@adclub/web-session";

/** `version` from this app's package.json, injected by `vite.config.ts`. */
export const APP_VERSION = __APP_VERSION__;

/** The API: `VITE_API_URL` of the build, otherwise the page's host on the API's development port. */
export const API_URL: string =
  import.meta.env.VITE_API_URL ??
  (typeof window === "undefined" ? "http://localhost:3000" : defaultApiUrl(window.location));

/**
 * The admin panel's connection to the API: the web session shared with the
 * supplier cabinet (`@adclub/web-session`, ARCHITECTURE 4.47, 4.52) — the
 * refresh token only in the HttpOnly cookie `adclub_admin_refresh`, the
 * access token only in this page's memory, one exchange for the tabs,
 * «Нет сети», «нужно обновить». The interface is Russian only (SCREENS 7.0).
 */
const client = createWebClient({
  apiUrl: API_URL,
  platform: "admin-web",
  version: APP_VERSION,
  language: "ru",
});

export const session = client.session;
export const apiClient = client.apiClient;
export const useUpdateRequiredMessage = client.useUpdateRequiredMessage;
export const useSessionState = client.useSessionState;
