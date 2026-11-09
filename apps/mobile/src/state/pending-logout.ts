import type { ExchangeResult } from "../services/session-fetch-core";

/**
 * Signing out without a network (PRODUCT 6.7; TASK-056, I866): the device is
 * a guest at once, as before, but the server still holds the session — and
 * with it this phone's push token, so the next owner of the phone would get
 * the previous person's pushes until the session expired. The session's
 * tokens are therefore kept (in the secure storage, `stores.ts`) as «a
 * sign-out to finish», and `POST /auth/logout` is sent with them once the
 * network is back; the server ends the session and takes the device off push.
 */
export interface PendingLogout {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

export function parsePendingLogout(raw: unknown): PendingLogout | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return typeof value.sessionId === "string" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    value.accessToken !== "" &&
    value.refreshToken !== ""
    ? {
        sessionId: value.sessionId,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
      }
    : null;
}

/**
 * Every sign-out still to finish, oldest first: a second person signing out
 * offline before the first one's went through must not push it out (each
 * session holds its own push token). Bounded — a phone offline for months
 * keeps the latest few; the server ends the rest when they expire.
 */
export const PENDING_LOGOUTS_LIMIT = 5;

export function parsePendingLogouts(raw: unknown): PendingLogout[] {
  if (!Array.isArray(raw)) return [];
  const list = raw
    .map(parsePendingLogout)
    .filter((entry): entry is PendingLogout => entry !== null);
  return withPendingLogouts([], list);
}

/** Adds sign-outs to the list: one per session, the newest kept within the limit. */
export function withPendingLogouts(
  list: readonly PendingLogout[],
  added: readonly PendingLogout[],
): PendingLogout[] {
  const merged = [...list];
  for (const entry of added) {
    const at = merged.findIndex((existing) => existing.sessionId === entry.sessionId);
    if (at >= 0) merged.splice(at, 1);
    merged.push(entry);
  }
  return merged.slice(-PENDING_LOGOUTS_LIMIT);
}

/** Whether a sign-out that failed must be finished later: only when the server never said anything. */
export function logoutNeedsRetry(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status !== "number" || status === 0 || status === 408 || status === 429 || status >= 500
  );
}

export interface FinishLogoutDeps {
  /** `POST /auth/logout` with this access token; the HTTP answer, or a throw for no network. */
  logout: (accessToken: string) => Promise<Response>;
  /** The token exchange (`session-fetch.ts`), never through the app's session. */
  exchange: (refreshToken: string) => Promise<ExchangeResult>;
}

/** `done` — the session is over on the server (or was already); `retry` — try at the next chance. */
export type FinishLogoutResult = "done" | "retry";

async function codeOf(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : undefined;
}

function verdictOf(response: Response): FinishLogoutResult | null {
  if (response.ok) return "done";
  if (response.status === 408 || response.status === 429 || response.status >= 500) return "retry";
  return null;
}

export async function finishPendingLogout(
  pending: PendingLogout,
  deps: FinishLogoutDeps,
): Promise<FinishLogoutResult> {
  let response: Response;
  try {
    response = await deps.logout(pending.accessToken);
  } catch {
    return "retry";
  }
  const verdict = verdictOf(response);
  if (verdict) return verdict;
  if (response.status === 401 && (await codeOf(response)) === "ACCESS_TOKEN_EXPIRED") {
    // The access token lapsed while the phone was offline: the refresh token
    // still names the session — one exchange, then the sign-out with it.
    const exchanged = await deps.exchange(pending.refreshToken);
    if (exchanged.kind === "refused") return "done";
    if (exchanged.kind !== "ok") return "retry";
    try {
      response = await deps.logout(exchanged.tokens.accessToken);
    } catch {
      return "retry";
    }
    return verdictOf(response) ?? "done";
  }
  // `SESSION_ENDED` and any other refusal: there is no session left to end.
  return "done";
}
