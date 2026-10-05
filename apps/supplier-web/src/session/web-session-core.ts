import type { FetchLike } from "@adclub/api-client";
import { sessionTokensSchema } from "@adclub/contracts";

/**
 * The cabinet's session in the browser (TASK-031 requirement 3; ARCHITECTURE
 * 4.47), free of the DOM so that it is tested as it is: `web-session.ts`
 * only supplies the real `fetch`, the exchange request, the Web Locks and the
 * BroadcastChannel.
 *
 * - The refresh token is an HttpOnly cookie the page never sees; the access
 *   token lives only in this object's memory. A reloaded page has none and
 *   gets one by an exchange (`start`).
 * - `ACCESS_TOKEN_EXPIRED` is handled here once instead of by every screen:
 *   requests that expire together share one exchange and each is retried
 *   once; a request whose token was already replaced (by this tab or by
 *   another one) is just retried with the current one.
 * - Several tabs share one cookie. Exchanges are serialized across tabs by a
 *   lock, and the tab that exchanged shares the new access token, so the
 *   others don't rotate the refresh token again. Even without either (an old
 *   browser) nothing breaks: tabs send the same, latest cookie, and the
 *   server answers a repeated exchange within its grace period with the same
 *   pair (ARCHITECTURE 4.6 I49).
 * - The session is over only when the server says so: `SESSION_ENDED`,
 *   `SUPPLIER_ACCESS_CLOSED`, or a refusal of the exchange. A network
 *   failure, a timeout, a 5xx or a rate limit is not a verdict: the session
 *   stays, the caller sees a network error, the next request tries again.
 */

/** Why the cabinet shows the sign-in screen: decides the message above it. */
export type SignedOutReason =
  /** No session in this browser (never signed in, signed out, cookie gone): no message. */
  | "none"
  /** The server ended the session (another device, the 180 days ran out): T-SES-01. */
  | "session_ended"
  /** The employee was removed from the company: «Доступ к кабинету закрыт» (SCREENS 6.0). */
  | "access_closed";

export interface WebTokens {
  sessionId: string;
  accessToken: string;
  /** ISO 8601. */
  accessTokenExpiresAt: string;
}

export type ExchangeVerdict =
  | { kind: "ok"; tokens: WebTokens }
  | { kind: "ended"; reason: SignedOutReason }
  /** No answer worth believing: offline, timed out, a server error, a rate limit. */
  | { kind: "unavailable" }
  /** This build is below the server's minimum (`CLIENT_UPDATE_REQUIRED`). */
  | { kind: "update_required"; message: string };

export type SessionState =
  /** The first exchange of this page has not answered yet. */
  | { status: "starting" }
  | { status: "signed_in"; tokens: WebTokens }
  | { status: "signed_out"; reason: SignedOutReason }
  /** The first exchange could not reach the server: we don't know yet. */
  | { status: "unreachable" };

/** What the tabs of one browser tell each other. */
export type TabMessage =
  | { type: "tokens"; tokens: WebTokens }
  | { type: "token_request" }
  | { type: "signed_in" }
  | { type: "signed_out"; reason: SignedOutReason }
  /** The session now works for another company (`POST /auth/supplier-context`). */
  | { type: "context_changed" };

export interface TabChannel {
  post(message: TabMessage): void;
  subscribe(listener: (message: TabMessage) => void): () => void;
}

/** Runs `task` while no other tab of this browser runs one under the same lock. */
export type TabLock = <T>(task: () => Promise<T>) => Promise<T>;

export interface WebSessionDeps {
  /** The real `fetch` every attempt goes through. */
  fetch: FetchLike;
  /** The cookie exchange itself; never goes through the wrapped `fetch`. */
  exchange: () => Promise<ExchangeVerdict>;
  /** Cross-tab lock; absent — exchanges are only serialized within this tab. */
  lock?: TabLock;
  /** Cross-tab messages; absent — this tab is on its own. */
  channel?: TabChannel;
  /** How long to wait for another tab to share its token at start. Default 150 ms. */
  peerWaitMs?: number;
  /** How long one attempt may take; absent — only the caller's signal limits it. */
  attemptTimeoutMs?: number;
  /** Told when the server says this build must be updated. */
  onUpdateRequired?: (message: string) => void;
  /** Told when another tab switched the session to another company. */
  onContextChanged?: () => void;
  now?: () => number;
}

/** A token closer than this to its end is not worth taking from another tab. */
const PEER_TOKEN_MIN_LIFE_MS = 30_000;

function codeOf(body: unknown): string | undefined {
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code
    : undefined;
}

/** What an exchange said, from the HTTP answer. */
export async function exchangeVerdictOf(response: Response): Promise<ExchangeVerdict> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = sessionTokensSchema.safeParse(body);
    return parsed.success
      ? {
          kind: "ok",
          tokens: {
            sessionId: parsed.data.sessionId,
            accessToken: parsed.data.accessToken,
            accessTokenExpiresAt: parsed.data.accessTokenExpiresAt,
          },
        }
      : { kind: "unavailable" };
  }
  const code = codeOf(body);
  if (code === "CLIENT_UPDATE_REQUIRED") {
    const message =
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : "";
    return { kind: "update_required", message };
  }
  if (code === "SUPPLIER_ACCESS_CLOSED") return { kind: "ended", reason: "access_closed" };
  if (code === "SESSION_ENDED") return { kind: "ended", reason: "session_ended" };
  // A browser this API does not know (a wrong SUPPLIER_WEB_ORIGINS) is a
  // configuration problem, not a verdict about the session.
  if (code === "ORIGIN_NOT_ALLOWED") return { kind: "unavailable" };
  const verdict =
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 408 &&
    response.status !== 429;
  return verdict ? { kind: "ended", reason: "none" } : { kind: "unavailable" };
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message, retryable: false }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const endedResponses: Record<SignedOutReason, () => Response> = {
  none: () => errorResponse(401, "AUTH_REQUIRED", "Sign in to the cabinet"),
  session_ended: () => errorResponse(401, "SESSION_ENDED", "The session has ended, sign in again"),
  access_closed: () =>
    errorResponse(401, "SUPPLIER_ACCESS_CLOSED", "Access to the supplier cabinet is closed"),
};

function bearerOf(init: RequestInit): string | undefined {
  const value = new Headers(init.headers).get("Authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

async function bodyCode(response: Response): Promise<string | undefined> {
  return codeOf(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  );
}

type RefreshOutcome =
  | { kind: "token"; token: string }
  | { kind: "ended"; reason: SignedOutReason }
  | { kind: "unavailable" }
  | { kind: "update_required"; message: string };

export interface WebSession {
  state(): SessionState;
  subscribe(listener: () => void): () => void;
  /** The access token to send now, if signed in. */
  accessToken(): string | undefined;
  /** Finds out whether this browser has a session (the page has just opened, or the network is back). */
  start(): Promise<void>;
  /** A sign-in finished on this page: the tokens of its answer. */
  signedIn(tokens: WebTokens): void;
  /** Shows the sign-in screen, and tells the other tabs. */
  signOut(reason: SignedOutReason): void;
  /** Tells the other tabs the session works for another company now. */
  contextChanged(): void;
  /** The `fetch` the API client uses. */
  fetch: FetchLike;
  dispose(): void;
}

export function createWebSession(deps: WebSessionDeps): WebSession {
  const now = deps.now ?? Date.now;
  const lock: TabLock = deps.lock ?? ((task) => task());
  const listeners = new Set<() => void>();
  let current: SessionState = { status: "starting" };

  function set(next: SessionState): void {
    current = next;
    listeners.forEach((listener) => listener());
  }

  function tokens(): WebTokens | undefined {
    return current.status === "signed_in" ? current.tokens : undefined;
  }

  function adopt(next: WebTokens): void {
    const mine = tokens();
    // Only a newer token of the same session; a stale broadcast never
    // replaces a fresher one (exchanges finish in any order).
    if (
      mine &&
      mine.sessionId === next.sessionId &&
      Date.parse(mine.accessTokenExpiresAt) >= Date.parse(next.accessTokenExpiresAt)
    ) {
      return;
    }
    set({ status: "signed_in", tokens: next });
  }

  function end(reason: SignedOutReason, tell: boolean): void {
    if (current.status === "signed_out" && current.reason === reason) return;
    set({ status: "signed_out", reason });
    if (tell) deps.channel?.post({ type: "signed_out", reason });
  }

  function alive(token: WebTokens): boolean {
    return Date.parse(token.accessTokenExpiresAt) - now() > PEER_TOKEN_MIN_LIFE_MS;
  }

  /** A fresh token another tab already holds, if one answers in time. */
  function askPeers(): Promise<WebTokens | undefined> {
    const channel = deps.channel;
    if (!channel) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(undefined);
      }, deps.peerWaitMs ?? 150);
      const unsubscribe = channel.subscribe((message) => {
        if (message.type !== "tokens" || !alive(message.tokens)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(message.tokens);
      });
      channel.post({ type: "token_request" });
    });
  }

  function share(next: WebTokens): void {
    deps.channel?.post({ type: "tokens", tokens: next });
  }

  // Shared by every request of this tab: a second request expiring while the
  // first exchange is in flight waits for it instead of starting its own.
  let refreshing: Promise<RefreshOutcome> | null = null;

  async function refreshOnce(expired: string | undefined): Promise<RefreshOutcome> {
    return lock(async () => {
      // While this tab waited for the lock, another one may have exchanged
      // and shared the result: no second rotation then.
      const mine = tokens();
      // …or signed out (in another tab): nothing to exchange for.
      if (!mine) return { kind: "ended", reason: "none" };
      if (mine.accessToken !== expired) return { kind: "token", token: mine.accessToken };
      const before = mine.sessionId;
      const verdict = await deps.exchange();
      switch (verdict.kind) {
        case "ok":
          // The page may have moved on meanwhile (signed out, another sign-in).
          if (current.status !== "signed_in" || current.tokens.sessionId !== before) {
            return { kind: "ended", reason: "none" };
          }
          set({ status: "signed_in", tokens: verdict.tokens });
          share(verdict.tokens);
          return { kind: "token", token: verdict.tokens.accessToken };
        case "ended":
          if (current.status === "signed_in" && current.tokens.sessionId === before) {
            end(verdict.reason, true);
          }
          return verdict;
        default:
          return verdict;
      }
    });
  }

  function sharedRefresh(expired: string | undefined): Promise<RefreshOutcome> {
    if (!refreshing) {
      refreshing = refreshOnce(expired).finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  /** One attempt: its own time limit, and the caller's signal still cancels it. */
  function attempt(input: string, init: RequestInit): Promise<Response> {
    const limit = deps.attemptTimeoutMs;
    if (limit === undefined) return deps.fetch(input, init);
    const controller = new AbortController();
    const outer = init.signal ?? undefined;
    const cancel = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener("abort", cancel);
    const timer = setTimeout(cancel, limit);
    return deps.fetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", cancel);
    });
  }

  const sessionFetch: FetchLike = async (input, init) => {
    const used = bearerOf(init);
    const response = await attempt(input, init);
    // Only requests made with a session are this object's business; sign-in
    // steps and public routes answer for themselves.
    if (response.status !== 401 || used === undefined) return response;
    const code = await bodyCode(response);

    if (code === "SESSION_ENDED" || code === "SUPPLIER_ACCESS_CLOSED") {
      // Only if it is still the session this request was made with: a late
      // answer must not sign out a newer sign-in.
      if (tokens()?.accessToken === used) {
        end(code === "SESSION_ENDED" ? "session_ended" : "access_closed", true);
      }
      return response;
    }
    if (code !== "ACCESS_TOKEN_EXPIRED" && code !== "AUTH_REQUIRED") return response;

    const mine = tokens();
    if (!mine) return response;
    if (mine.accessToken !== used) return attempt(input, withBearer(init, mine.accessToken));

    const outcome = await sharedRefresh(used);
    switch (outcome.kind) {
      case "token":
        return attempt(input, withBearer(init, outcome.token));
      case "ended":
        return endedResponses[outcome.reason]();
      case "update_required":
        deps.onUpdateRequired?.(outcome.message);
        return errorResponse(426, "CLIENT_UPDATE_REQUIRED", outcome.message);
      default:
        // Not the server's verdict: fail like a lost connection does.
        throw new TypeError("Network request failed");
    }
  };

  const unsubscribeChannel = deps.channel?.subscribe((message) => {
    switch (message.type) {
      case "tokens":
        adopt(message.tokens);
        break;
      case "token_request": {
        const mine = tokens();
        if (mine && alive(mine)) share(mine);
        break;
      }
      case "signed_in":
        // Another tab signed in: this browser has a session cookie now.
        if (current.status !== "signed_in") void start();
        break;
      case "signed_out":
        if (current.status === "signed_in") end(message.reason, false);
        break;
      case "context_changed":
        if (current.status === "signed_in") deps.onContextChanged?.();
        break;
    }
  });

  let starting: Promise<void> | null = null;

  function start(): Promise<void> {
    if (!starting) {
      starting = (async () => {
        const fromPeer = await askPeers();
        if (fromPeer) {
          adopt(fromPeer);
          return;
        }
        const verdict = await lock(async () => {
          // Another tab may have shared a token while this one waited.
          const shared = tokens();
          if (shared && alive(shared)) return null;
          return deps.exchange();
        });
        if (verdict === null) return;
        switch (verdict.kind) {
          case "ok":
            set({ status: "signed_in", tokens: verdict.tokens });
            share(verdict.tokens);
            break;
          case "ended":
            set({ status: "signed_out", reason: verdict.reason });
            break;
          case "update_required":
            deps.onUpdateRequired?.(verdict.message);
            if (current.status === "starting") set({ status: "unreachable" });
            break;
          default:
            if (current.status !== "signed_in") set({ status: "unreachable" });
        }
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    accessToken: () => tokens()?.accessToken,
    start,
    signedIn(next) {
      set({ status: "signed_in", tokens: next });
      share(next);
      deps.channel?.post({ type: "signed_in" });
    },
    signOut(reason) {
      end(reason, true);
    },
    contextChanged() {
      deps.channel?.post({ type: "context_changed" });
    },
    fetch: sessionFetch,
    dispose() {
      unsubscribeChannel?.();
      listeners.clear();
    },
  };
}
