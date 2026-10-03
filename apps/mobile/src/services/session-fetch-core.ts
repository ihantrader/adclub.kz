import { sessionTokensSchema, type SessionTokens } from "@adclub/contracts";
import type { FetchLike } from "@adclub/api-client";
import type { StoredSession } from "../state/session-store";

/**
 * The rules of the automatic token exchange (TASK-029 requirement 4;
 * ARCHITECTURE 4.41), free of React Native and of the app's stores so that
 * they are tested as they are: `session-fetch.ts` only supplies the real
 * `fetch`, the stores and the exchange request.
 *
 * - `ACCESS_TOKEN_EXPIRED` is handled here, once, instead of by every screen:
 *   requests that expire together share one exchange and each is retried
 *   once with its result; a request whose token another one has already
 *   replaced is just retried with the current one — no second rotation.
 * - A session the server says is over — `SESSION_ENDED` on any request (the
 *   user ended it from another device, an administrator did) or a refusal of
 *   the exchange itself — leaves the app signed out, once, with the notice.
 * - A refresh that merely could not be done — no network, a timeout, a
 *   server error — signs nobody out: the session stays, the caller sees a
 *   network error, and the next request tries again.
 */

export type ExchangeResult =
  | { kind: "ok"; tokens: SessionTokens }
  /** The server refused this refresh token: the session is over. */
  | { kind: "refused" }
  /** No answer worth believing: offline, timed out, a server error, a bad body. */
  | { kind: "unavailable" };

export interface SessionFetchDeps {
  /** The wrapped `fetch`. */
  fetch: FetchLike;
  /** The session now, `null` — a guest. */
  currentSession: () => StoredSession | null;
  /** Stores the pair an exchange returned, for the session it was made for. */
  renewSession: (sessionId: string, tokens: SessionTokens) => void;
  /** Signs the app out and tells the user why. Called at most once per ended session. */
  endSession: () => void;
  /** The exchange request itself; never goes through the wrapped `fetch`. */
  exchange: (refreshToken: string) => Promise<ExchangeResult>;
}

/** What an exchange said, from the HTTP answer (`unavailable` for anything that is not a verdict). */
export async function exchangeResultOf(response: Response): Promise<ExchangeResult> {
  if (response.ok) {
    const parsed = sessionTokensSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { kind: "ok", tokens: parsed.data } : { kind: "unavailable" };
  }
  // A refusal of the token itself, not a slow or broken server (408, 429, 5xx).
  const verdict = response.status >= 400 && response.status < 500;
  return verdict && response.status !== 408 && response.status !== 429
    ? { kind: "refused" }
    : { kind: "unavailable" };
}

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

function bearerOf(init: RequestInit): string | undefined {
  const value = new Headers(init.headers).get("Authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export function createSessionAwareFetch(deps: SessionFetchDeps): FetchLike {
  // Shared by every call: a second request expiring while the first exchange
  // is in flight waits for it instead of starting its own.
  let refreshing: Promise<string | "ended" | "unavailable"> | null = null;

  async function refreshOnce(): Promise<string | "ended" | "unavailable"> {
    const before = deps.currentSession();
    if (!before) return "ended";
    const result = await deps.exchange(before.refreshToken);
    if (result.kind === "refused") {
      // Only if it is still the session the exchange was made for: a sign-in
      // that happened meanwhile is not ended by an old refusal.
      if (deps.currentSession()?.sessionId === before.sessionId) {
        deps.endSession();
      }
      return "ended";
    }
    if (result.kind === "unavailable") return "unavailable";
    // The session may have moved on while the exchange was in flight (a
    // sign-out, a sign-in of someone else): only the same one gets the pair.
    deps.renewSession(before.sessionId, result.tokens);
    return result.tokens.accessToken;
  }

  function sharedRefresh(): Promise<string | "ended" | "unavailable"> {
    if (!refreshing) {
      refreshing = refreshOnce().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  return async (input, init) => {
    const response = await deps.fetch(input, init);
    if (response.status !== 401) return response;
    const code = await bodyCode(response);

    if (code === "SESSION_ENDED") {
      // The server says it, not a failed exchange: another device ended it,
      // an administrator did. Only if it is still the session this request
      // was made with — a late answer must not sign out a newer sign-in.
      const used = bearerOf(init);
      const current = deps.currentSession();
      if (current && (used === undefined || used === current.accessToken)) {
        deps.endSession();
      }
      return response;
    }
    if (code !== "ACCESS_TOKEN_EXPIRED") return response;

    // Another request already replaced the token this one expired with.
    const used = bearerOf(init);
    const current = deps.currentSession();
    if (current && used !== undefined && used !== current.accessToken) {
      return deps.fetch(input, withBearer(init, current.accessToken));
    }

    const token = await sharedRefresh();
    if (token === "ended") return sessionEndedResponse();
    if (token === "unavailable") {
      // Not the verdict of the server: a fetch that failed like a network one does.
      throw new TypeError("Network request failed");
    }
    return deps.fetch(input, withBearer(init, token));
  };
}
