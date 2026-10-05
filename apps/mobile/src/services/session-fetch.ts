import { apiRoutes, CLIENT_HEADER, formatClientHeader } from "@adclub/contracts";
import type { FetchLike } from "@adclub/api-client";
import { apiUrl, clientInfo } from "../config/environment";
import { clearSession, sessionStore } from "../state/stores";
import {
  createSessionAwareFetch as createFetch,
  exchangeResultOf,
  type ExchangeResult,
} from "./session-fetch-core";

/**
 * Automatic token exchange (TASK-029 requirement 4): wraps `fetch` for the
 * app's one API client (`services/api.ts`) so an expired access token, or a
 * session the server has ended, is handled here, once, instead of by every
 * screen that calls the API. The rules — one exchange at a time, one retry
 * per request, who is signed out and who is not — are in
 * `session-fetch-core.ts`, where they are tested; this file only connects
 * them to the real `fetch`, the session store and the refresh request.
 *
 * This lives in the app, not in `@adclub/api-client`: only the mobile
 * session carries a refresh token the client can exchange by itself — the
 * web clients' refresh token is an HttpOnly cookie the browser resends on
 * its own, and their sign-in screens are a later task.
 */
export interface SessionFetchCallbacks {
  /** The session turned out to be over; the caller shows the guest view with an explanation. */
  onSessionEnded: () => void;
}

const REFRESH_TIMEOUT_MS = 8_000;

/**
 * One attempt of a request (the first, or the retry after an exchange); the
 * API client's own limit (`services/api.ts`) covers the whole call — attempt,
 * exchange and retry — and is longer, so a slow exchange does not cut the
 * retry short (TASK-029.B).
 */
export const ATTEMPT_TIMEOUT_MS = 8_000;

/** The exchange itself, independent of the wrapped `fetch` — never recurses through it. */
async function exchangeRefreshToken(refreshToken: string): Promise<ExchangeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(`${apiUrl}${apiRoutes.refreshSession.path}`, {
      method: apiRoutes.refreshSession.method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [CLIENT_HEADER]: formatClientHeader(clientInfo),
      },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
    return await exchangeResultOf(response);
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export function createSessionAwareFetch(callbacks: SessionFetchCallbacks): FetchLike {
  return createFetch({
    fetch: (input, init) => globalThis.fetch(input, init),
    currentSession: () => {
      const state = sessionStore.get();
      return state.status === "signed_in" ? state.session : null;
    },
    renewSession: (sessionId, tokens) => {
      const state = sessionStore.get();
      if (state.status !== "signed_in" || state.session.sessionId !== sessionId) return;
      sessionStore.set({
        status: "signed_in",
        session: {
          ...state.session,
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshToken: tokens.refreshToken ?? state.session.refreshToken,
          sessionExpiresAt: tokens.sessionExpiresAt,
        },
      });
    },
    endSession: () => {
      clearSession();
      callbacks.onSessionEnded();
    },
    exchange: exchangeRefreshToken,
    attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  });
}
