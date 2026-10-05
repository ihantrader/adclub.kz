import { createApiClient } from "@adclub/api-client";
import type { Lang } from "@adclub/i18n";
import { apiUrl, clientInfo, systemLanguage } from "../config/environment";
import { startLanguage } from "../start/start-decision";
import { languageStore, sessionStore } from "../state/stores";
import { UpdateGate } from "../update-gate";
import {
  ATTEMPT_TIMEOUT_MS,
  createSessionAwareFetch,
  type SessionFetchCallbacks,
} from "./session-fetch";

/** The language every request is made in — the current interface language. */
export function requestLanguage(): Lang {
  return startLanguage(languageStore.get(), systemLanguage);
}

export const updateGate: UpdateGate = new UpdateGate(() => apiClient.getClientPolicy(), clientInfo);

/**
 * Told about a session that turned out to be over (TASK-029): the session
 * provider fills this in once it mounts, so a token exchange that fails
 * before any screen has rendered doesn't throw into the void. Until then a
 * failed exchange still signs the app out (`clearSession`, inside
 * `createSessionAwareFetch`) — only the explanatory notice is delayed.
 */
export const sessionEndedNotice: { current: () => void } = { current: () => undefined };

const sessionFetchCallbacks: SessionFetchCallbacks = {
  onSessionEnded: () => sessionEndedNotice.current(),
};

/**
 * The app's single API client (TASK-027 requirement 6): every request of
 * every screen goes through it, carries `X-Client: mobile/<version>
 * (ios|android)` and `Accept-Language` of the current interface language,
 * and every `CLIENT_UPDATE_REQUIRED` answer switches the app to the update
 * screen at the moment it arrives. `getAccessToken` reads the signed-in
 * session (TASK-029; `null` — a guest, no `Authorization` header is sent),
 * and `ACCESS_TOKEN_EXPIRED` is handled once, in the `fetch` this client is
 * given (`createSessionAwareFetch`), instead of by every call site.
 */
export const apiClient = createApiClient({
  baseUrl: apiUrl,
  client: clientInfo,
  getLanguage: requestLanguage,
  getAccessToken: () => {
    const session = sessionStore.get();
    return session.status === "signed_in" ? session.session.accessToken : undefined;
  },
  fetch: createSessionAwareFetch(sessionFetchCallbacks),
  // A phone on a flaky network shouldn't wait long at start-up: each attempt
  // is limited to 8 s (`ATTEMPT_TIMEOUT_MS`); this covers a whole call — an
  // attempt, a token exchange (8 s at most) and the retry.
  timeoutMs: 3 * ATTEMPT_TIMEOUT_MS,
  onError: updateGate.handleApiError,
});
