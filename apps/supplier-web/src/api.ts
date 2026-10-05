import { createApiClient, type ApiError, type FetchLike } from "@adclub/api-client";
import { apiRoutes } from "@adclub/contracts";
import { useSyncExternalStore } from "react";
import { API_URL, APP_VERSION } from "./config";
import { reportRequestOutcome, setReachabilityProbe } from "./connection";
import { createBrowserSession } from "./session/web-session";

let currentLanguage = "ru";
let updateRequiredMessage: string | null = null;
const updateListeners = new Set<() => void>();
const contextListeners = new Set<() => void>();

function requireUpdate(message: string): void {
  if (updateRequiredMessage === message) return;
  updateRequiredMessage = message;
  updateListeners.forEach((listener) => listener());
}

const client = { platform: "supplier-web", version: APP_VERSION } as const;

setReachabilityProbe(`${API_URL}${apiRoutes.getHealth.path}`);

/** The cabinet's session: the HttpOnly cookie and the access token in memory (`session/`). */
export const session = createBrowserSession({
  apiUrl: API_URL,
  client,
  onUpdateRequired: requireUpdate,
  onContextChanged: () => contextListeners.forEach((listener) => listener()),
});

/** Every request: whether it reached the server decides the «Нет сети» banner. */
const trackedFetch: FetchLike = async (input, init) => {
  try {
    const response = await session.fetch(input, init);
    reportRequestOutcome(true);
    return response;
  } catch (error) {
    if (!init.signal?.aborted) reportRequestOutcome(false);
    throw error;
  }
};

function handleApiError(error: ApiError): void {
  if (error.code === "CLIENT_UPDATE_REQUIRED") requireUpdate(error.message);
}

export function setApiLanguage(lang: string): void {
  currentLanguage = lang;
}

export const apiClient = createApiClient({
  baseUrl: API_URL,
  client,
  getLanguage: () => currentLanguage,
  getAccessToken: () => session.accessToken(),
  // Sign-in and its steps set HttpOnly cookies of the API origin (the
  // session's and the step's, ARCHITECTURE 4.6 I54, 4.9 I80).
  credentials: "include",
  fetch: trackedFetch,
  // One call may be an attempt, an exchange and a retry (each limited on its own).
  timeoutMs: 30_000,
  onError: handleApiError,
});

/** Another tab switched the session to another company. */
export function onContextChanged(listener: () => void): () => void {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
}

/**
 * The server's "update required" text once any request was refused with
 * `CLIENT_UPDATE_REQUIRED` (this build is below the
 * `client_min_version_supplier_web` setting), `null` otherwise.
 */
export function useUpdateRequiredMessage(): string | null {
  return useSyncExternalStore(
    (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    () => updateRequiredMessage,
  );
}

export function useSessionState() {
  return useSyncExternalStore(session.subscribe, session.state);
}
