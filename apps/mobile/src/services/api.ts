import { createApiClient } from "@adclub/api-client";
import { apiUrl, clientInfo, language } from "../config/environment";
import { UpdateGate } from "../update-gate";

export const updateGate: UpdateGate = new UpdateGate(() => apiClient.getClientPolicy(), clientInfo);

/**
 * The app's single API client: every request carries `X-Client` and the
 * interface language, and every `CLIENT_UPDATE_REQUIRED` answer switches
 * the app to the update screen.
 */
export const apiClient = createApiClient({
  baseUrl: apiUrl,
  client: clientInfo,
  getLanguage: () => language,
  // A phone on a flaky network shouldn't wait long at start-up.
  timeoutMs: 8_000,
  onError: updateGate.handleApiError,
});
