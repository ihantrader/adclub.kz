import { apiRoutes, CLIENT_HEADER, formatClientHeader } from "@adclub/contracts";
import type { FetchLike } from "@adclub/api-client";
import { apiUrl, clientInfo } from "../config/environment";
import { clearSession, sessionStore } from "../state/stores";
import type { StoredSession } from "../state/session-store";

/**
 * Automatic token exchange (TASK-029 requirement 4): wraps `fetch` for the
 * app's one API client (`services/api.ts`) so an `ACCESS_TOKEN_EXPIRED`
 * response is handled here, once, instead of by every screen that calls the
 * API. Concurrent requests that expire together share one exchange
 * (`refreshing`, a module-level in-flight promise) and each retries with
 * whatever token it produced — never more than one exchange at a time, and
 * never a request retried more than once. A refresh that fails for any
 * reason (the session was ended or has expired, the network is down) signs
 * the app out and hands the original caller `SESSION_ENDED`, so every call
 * site already reacting to that code (a clean drop to the guest view) reacts
 * the same way here, without a crash screen.
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

interface RefreshOutcome {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
  sessionExpiresAt: string;
}

function isRefreshOutcome(value: unknown): value is RefreshOutcome {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.accessToken === "string" &&
    typeof body.accessTokenExpiresAt === "string" &&
    typeof body.sessionExpiresAt === "string" &&
    (body.refreshToken === undefined || typeof body.refreshToken === "string")
  );
}

/** The exchange itself, independent of the wrapped `fetch` — never recurses through it. */
async function exchangeRefreshToken(refreshToken: string): Promise<RefreshOutcome | null> {
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
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    return isRefreshOutcome(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** A 401 this app treats exactly like the server's own `SESSION_ENDED`. */
function sessionEndedResponse(): Response {
  return new Response(
    JSON.stringify({
      code: "SESSION_ENDED",
      message: "The session has ended, sign in again",
      retryable: false,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

async function bodyCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code
    : undefined;
}

export function createSessionAwareFetch(callbacks: SessionFetchCallbacks): FetchLike {
  // Shared by every call: a second request expiring while the first refresh
  // is in flight waits for it instead of starting its own.
  let refreshing: Promise<string | null> | null = null;

  async function refreshOnce(): Promise<string | null> {
    const before = sessionStore.get();
    if (before.status !== "signed_in") return null;
    const outcome = await exchangeRefreshToken(before.session.refreshToken);
    if (!outcome) {
      clearSession();
      callbacks.onSessionEnded();
      return null;
    }
    // The session may have moved on while the exchange was in flight (a
    // sign-out, a second exchange elsewhere); only a still-signed-in session
    // for the very same one gets the new pair.
    const current = sessionStore.get();
    if (current.status !== "signed_in" || current.session.sessionId !== before.session.sessionId) {
      return outcome.accessToken;
    }
    const next: StoredSession = {
      ...current.session,
      accessToken: outcome.accessToken,
      accessTokenExpiresAt: outcome.accessTokenExpiresAt,
      refreshToken: outcome.refreshToken ?? current.session.refreshToken,
      sessionExpiresAt: outcome.sessionExpiresAt,
    };
    sessionStore.set({ status: "signed_in", session: next });
    return next.accessToken;
  }

  function sharedRefresh(): Promise<string | null> {
    if (!refreshing) {
      refreshing = refreshOnce().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.status !== 401) return response;
    if ((await bodyCode(response)) !== "ACCESS_TOKEN_EXPIRED") return response;

    const token = await sharedRefresh();
    if (!token) return sessionEndedResponse();
    return globalThis.fetch(input, withBearer(init, token));
  };
}
