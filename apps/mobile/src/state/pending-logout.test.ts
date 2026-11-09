import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import { openFromColdStart } from "../push/cold-start";
import type { PushMessage } from "../push/push-logic";
import type { ExchangeResult } from "../services/session-fetch-core";
import {
  finishPendingLogout,
  logoutNeedsRetry,
  parsePendingLogout,
  parsePendingLogouts,
  PENDING_LOGOUTS_LIMIT,
  withPendingLogouts,
  type PendingLogout,
} from "./pending-logout";

const PENDING: PendingLogout = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  accessToken: "access-old",
  refreshToken: "refresh-1",
};

const answer = (status: number, code?: string) =>
  new Response(JSON.stringify(code ? { code, message: code, retryable: false } : {}), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fresh: ExchangeResult = {
  kind: "ok",
  tokens: {
    sessionId: PENDING.sessionId,
    kind: "mobile",
    accessToken: "access-new",
    accessTokenExpiresAt: "2026-11-09T11:00:00.000Z",
    refreshToken: "refresh-2",
    sessionExpiresAt: "2026-12-09T10:00:00.000Z",
  },
};

describe("signing out without a network (I866)", () => {
  it("is finished later only when the server never answered", () => {
    expect(
      logoutNeedsRetry(
        new ApiError({ code: "NETWORK_ERROR", message: "offline", status: 0, retryable: true }),
      ),
    ).toBe(true);
    expect(logoutNeedsRetry(new TypeError("Network request failed"))).toBe(true);
    expect(
      logoutNeedsRetry(
        new ApiError({ code: "INTERNAL_ERROR", message: "x", status: 503, retryable: true }),
      ),
    ).toBe(true);
    expect(
      logoutNeedsRetry(
        new ApiError({ code: "SESSION_ENDED", message: "x", status: 401, retryable: false }),
      ),
    ).toBe(false);
  });

  it("offline, then online: the sign-out reaches the server", async () => {
    let online = false;
    const sent: string[] = [];
    const deps = {
      logout: (token: string) => {
        if (!online) return Promise.reject(new TypeError("Network request failed"));
        sent.push(token);
        return Promise.resolve(answer(200));
      },
      exchange: () => Promise.resolve(fresh),
    };
    expect(await finishPendingLogout(PENDING, deps)).toBe("retry");
    online = true;
    expect(await finishPendingLogout(PENDING, deps)).toBe("done");
    expect(sent).toEqual(["access-old"]);
  });

  it("an access token that lapsed meanwhile is exchanged once, then the sign-out", async () => {
    const sent: string[] = [];
    const exchanges: string[] = [];
    const result = await finishPendingLogout(PENDING, {
      logout: (token) => {
        sent.push(token);
        return Promise.resolve(
          token === "access-old" ? answer(401, "ACCESS_TOKEN_EXPIRED") : answer(200),
        );
      },
      exchange: (refresh) => {
        exchanges.push(refresh);
        return Promise.resolve(fresh);
      },
    });
    expect(result).toBe("done");
    expect(sent).toEqual(["access-old", "access-new"]);
    expect(exchanges).toEqual(["refresh-1"]);
  });

  it("a session already over is done; a refused exchange is done; a 5xx waits", async () => {
    const never = () => Promise.reject(new Error("no exchange expected"));
    expect(
      await finishPendingLogout(PENDING, {
        logout: () => Promise.resolve(answer(401, "SESSION_ENDED")),
        exchange: never,
      }),
    ).toBe("done");
    expect(
      await finishPendingLogout(PENDING, {
        logout: () => Promise.resolve(answer(401, "ACCESS_TOKEN_EXPIRED")),
        exchange: () => Promise.resolve({ kind: "refused" }),
      }),
    ).toBe("done");
    expect(
      await finishPendingLogout(PENDING, {
        logout: () => Promise.resolve(answer(503)),
        exchange: never,
      }),
    ).toBe("retry");
  });

  it("keeps a sign-out of another person beside the first, one per session, the latest few", () => {
    const second = { ...PENDING, sessionId: "33333333-3333-4333-8333-333333333333" };
    const both = withPendingLogouts([PENDING], [second]);
    expect(both).toEqual([PENDING, second]);
    // The same session again replaces itself, not the other.
    expect(withPendingLogouts(both, [{ ...PENDING, accessToken: "access-2" }])).toEqual([
      second,
      { ...PENDING, accessToken: "access-2" },
    ]);
    const many = Array.from({ length: PENDING_LOGOUTS_LIMIT + 2 }, (_, i) => ({
      ...PENDING,
      sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    expect(parsePendingLogouts(many)).toHaveLength(PENDING_LOGOUTS_LIMIT);
    expect(parsePendingLogouts([PENDING, "junk", { sessionId: "x" }])).toEqual([PENDING]);
  });

  it("reads back only a whole pending sign-out", () => {
    expect(parsePendingLogout(PENDING)).toEqual(PENDING);
    expect(parsePendingLogout({ ...PENDING, refreshToken: "" })).toBeNull();
    expect(parsePendingLogout("x")).toBeNull();
  });
});

describe("opened from a push at a cold start (I866)", () => {
  const ORDER = "1d2c3b4a-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
  const message: PushMessage = {
    notificationId: "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69",
    target: { screen: "order", params: { orderId: ORDER } },
  };

  it("opens the order even when reading the session takes longer than a second", async () => {
    let signedIn = false;
    const opened: PushMessage[] = [];
    // The secure storage answers after 1.5 s.
    const sessionRead = new Promise<void>((resolve) =>
      setTimeout(() => {
        signedIn = true;
        resolve();
      }, 1500),
    );
    const started = Date.now();
    const result = await openFromColdStart({
      initial: () => Promise.resolve(message),
      sessionRead,
      signedIn: () => signedIn,
      open: (m) => opened.push(m),
    });
    expect(result).toBe("opened");
    expect(opened).toEqual([message]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });

  it("opens nothing for a guest or without a push", async () => {
    const opened: PushMessage[] = [];
    const deps = {
      sessionRead: Promise.resolve(),
      signedIn: () => false,
      open: (m: PushMessage) => opened.push(m),
    };
    expect(await openFromColdStart({ ...deps, initial: () => Promise.resolve(message) })).toBe(
      "signed_out",
    );
    expect(await openFromColdStart({ ...deps, initial: () => Promise.resolve(null) })).toBe("none");
    expect(opened).toEqual([]);
  });
});
