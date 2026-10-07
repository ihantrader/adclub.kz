/**
 * What the two web clients — the supplier cabinet and the admin panel —
 * share about the session and the API (TASK-031, TASK-034; ARCHITECTURE
 * 4.47, 4.52): the session on an HttpOnly cookie with the access token in
 * memory, one exchange for every expired request and agreement between
 * tabs, «Нет сети», «нужно обновить», and the small helpers of the sign-in
 * screens (the phone number, the device's name).
 */
export {
  createWebSession,
  exchangeVerdictOf,
  type ExchangeVerdict,
  type SessionState,
  type SignedOutReason,
  type TabChannel,
  type TabLock,
  type TabMessage,
  type WebSession,
  type WebSessionDeps,
  type WebTokens,
} from "./session-core";
export {
  createBrowserSession,
  type BrowserSessionOptions,
  type WebPlatform,
} from "./browser-session";
export { createWebClient, type WebClient, type WebClientOptions } from "./web-client";
export {
  isOnline,
  reportRequestOutcome,
  setReachabilityProbe,
  subscribeOnline,
  useOnline,
} from "./connection";
export { DEV_API_PORT, defaultApiUrl } from "./api-url";
export { deviceName } from "./device-name";
export { formatPhone, typePhone } from "./phone";
