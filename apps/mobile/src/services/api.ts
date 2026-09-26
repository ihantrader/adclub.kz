import { createApiClient } from "@adclub/api-client";
import type { Lang } from "@adclub/i18n";
import { apiUrl, clientInfo, systemLanguage } from "../config/environment";
import { startLanguage } from "../start/start-decision";
import { languageStore } from "../state/stores";
import { UpdateGate } from "../update-gate";

/** The language every request is made in — the current interface language. */
export function requestLanguage(): Lang {
  return startLanguage(languageStore.get(), systemLanguage);
}

export const updateGate: UpdateGate = new UpdateGate(() => apiClient.getClientPolicy(), clientInfo);

/**
 * The app's single API client (TASK-027 requirement 6): every request of
 * every screen goes through it, carries `X-Client: mobile/<version>
 * (ios|android)` and `Accept-Language` of the current interface language,
 * and every `CLIENT_UPDATE_REQUIRED` answer switches the app to the update
 * screen at the moment it arrives. Tokens are not stored here yet
 * (TASK-029): the client already accepts `getAccessToken`.
 */
export const apiClient = createApiClient({
  baseUrl: apiUrl,
  client: clientInfo,
  getLanguage: requestLanguage,
  // A phone on a flaky network shouldn't wait long at start-up.
  timeoutMs: 8_000,
  onError: updateGate.handleApiError,
});
