import { createWebClient } from "@adclub/web-session";
import { API_URL, APP_VERSION } from "./config";

/**
 * The cabinet's connection to the API: the web session shared with the
 * admin panel (`@adclub/web-session`, ARCHITECTURE 4.47, 4.52) — the
 * HttpOnly cookie, the access token in memory, «Нет сети», «нужно обновить».
 */
const client = createWebClient({ apiUrl: API_URL, platform: "supplier-web", version: APP_VERSION });

export const session = client.session;
export const apiClient = client.apiClient;
export const setApiLanguage = client.setApiLanguage;
/** Another tab switched the session to another company. */
export const onContextChanged = client.onContextChanged;
export const useUpdateRequiredMessage = client.useUpdateRequiredMessage;
export const useSessionState = client.useSessionState;
