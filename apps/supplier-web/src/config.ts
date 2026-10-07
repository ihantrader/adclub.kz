import { defaultApiUrl } from "@adclub/web-session";

/** `version` from this app's package.json, injected by `vite.config.ts`. */
export const APP_VERSION = __APP_VERSION__;

/**
 * The API: `VITE_API_URL` of the build, otherwise the same host as the page
 * on the API's development port (`defaultApiUrl`; `pnpm dev:lan` — over its
 * TLS proxy).
 */
export const API_URL: string =
  import.meta.env.VITE_API_URL ??
  (typeof window === "undefined" ? "http://localhost:3000" : defaultApiUrl(window.location));
