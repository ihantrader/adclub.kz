import { createApiClient, type ApiClient, type ApiError, type FetchLike } from "@adclub/api-client";
import { apiRoutes } from "@adclub/contracts";
import { useSyncExternalStore } from "react";
import { createBrowserSession, type WebPlatform } from "./browser-session";
import { reportRequestOutcome, setReachabilityProbe } from "./connection";
import type { SessionState, WebSession } from "./session-core";

export interface WebClientOptions {
  apiUrl: string;
  platform: WebPlatform;
  /** This build's version, sent as `X-Client: <platform>/<version>`. */
  version: string;
  /** The language of the server's texts at the start (`Accept-Language`). */
  language?: string;
}

/** One web client's connection to the API: the session, the typed client and what they tell the page. */
export interface WebClient {
  /** The session: the HttpOnly cookie and the access token in memory. */
  session: WebSession;
  apiClient: ApiClient;
  setApiLanguage(lang: string): void;
  /** Another tab switched the session's context (the cabinet's company). */
  onContextChanged(listener: () => void): () => void;
  /**
   * The server's "update required" text once any request was refused with
   * `CLIENT_UPDATE_REQUIRED` (this build is below the
   * `client_min_version_<platform>` setting), `null` otherwise.
   */
  useUpdateRequiredMessage(): string | null;
  useSessionState(): SessionState;
}

/**
 * What the supplier cabinet and the admin panel share about talking to the
 * API (TASK-031, TASK-034; ARCHITECTURE 4.47, 4.52): every request through
 * the session (one exchange for the expired access token, the tabs agree),
 * with cookies (the session's and the sign-in step's, 4.6 I54, 4.9 I80),
 * reporting whether it reached the server («Нет сети»), and «нужно
 * обновить» from any refusal.
 */
export function createWebClient(options: WebClientOptions): WebClient {
  let currentLanguage = options.language ?? "ru";
  let updateRequiredMessage: string | null = null;
  const updateListeners = new Set<() => void>();
  const contextListeners = new Set<() => void>();

  function requireUpdate(message: string): void {
    if (updateRequiredMessage === message) return;
    updateRequiredMessage = message;
    updateListeners.forEach((listener) => listener());
  }

  const client = { platform: options.platform, version: options.version } as const;

  setReachabilityProbe(`${options.apiUrl}${apiRoutes.getHealth.path}`);

  const session = createBrowserSession({
    apiUrl: options.apiUrl,
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

  const apiClient = createApiClient({
    baseUrl: options.apiUrl,
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

  const subscribeUpdate = (listener: () => void) => {
    updateListeners.add(listener);
    return () => {
      updateListeners.delete(listener);
    };
  };

  return {
    session,
    apiClient,
    setApiLanguage(lang) {
      currentLanguage = lang;
    },
    onContextChanged(listener) {
      contextListeners.add(listener);
      return () => {
        contextListeners.delete(listener);
      };
    },
    useUpdateRequiredMessage() {
      return useSyncExternalStore(subscribeUpdate, () => updateRequiredMessage);
    },
    useSessionState() {
      return useSyncExternalStore(session.subscribe, session.state);
    },
  };
}
