import type { SessionTokens } from "@adclub/contracts";
import { describe, expect, it, vi } from "vitest";
import type { StoredSession } from "../state/session-store";
import {
  createSessionAwareFetch,
  exchangeResultOf,
  type ExchangeResult,
  type SessionFetchDeps,
} from "./session-fetch-core";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    accountId: "22222222-2222-4222-8222-222222222222",
    sessionId: SESSION_ID,
    kind: "mobile",
    accessToken: "access-1",
    accessTokenExpiresAt: "2026-10-03T10:00:00.000Z",
    refreshToken: "refresh-1",
    sessionExpiresAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

function tokens(n: number): SessionTokens {
  return {
    sessionId: SESSION_ID,
    kind: "mobile",
    accessToken: `access-${String(n)}`,
    accessTokenExpiresAt: "2026-10-03T11:00:00.000Z",
    refreshToken: `refresh-${String(n)}`,
    sessionExpiresAt: "2026-11-03T11:00:00.000Z",
  };
}

const answer = (status: number, code?: string): Response =>
  new Response(JSON.stringify(code ? { code, message: code, retryable: false } : { ok: true }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The app's side of the exchange, in memory: a session, the calls made, who was signed out. */
function world(options: { exchange?: () => Promise<ExchangeResult> } = {}) {
  let current: StoredSession | null = session();
  const calls: Array<{ url: string; token: string | undefined }> = [];
  const exchanges: string[] = [];
  let ended = 0;
  // What the "server" says to a request, by the token it carried.
  let serverSays: (token: string | undefined, url: string) => Response = () => answer(200);

  const deps: SessionFetchDeps = {
    fetch: (input, init) => {
      const token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
      calls.push({ url: input, token });
      return Promise.resolve(serverSays(token, input));
    },
    currentSession: () => current,
    renewSession: (sessionId, next) => {
      if (current?.sessionId !== sessionId) return;
      current = {
        ...current,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken ?? current.refreshToken,
      };
    },
    endSession: () => {
      ended += 1;
      current = null;
    },
    exchange: async (refreshToken) => {
      exchanges.push(refreshToken);
      return (await options.exchange?.()) ?? { kind: "ok", tokens: tokens(exchanges.length + 1) };
    },
  };
  const fetch = createSessionAwareFetch(deps);
  const call = (url: string, token = current?.accessToken) =>
    fetch(url, { headers: { Authorization: `Bearer ${token ?? ""}` } });
  return {
    call,
    calls,
    exchanges,
    get ended() {
      return ended;
    },
    get session() {
      return current;
    },
    setSession: (next: StoredSession | null) => {
      current = next;
    },
    says: (rule: (token: string | undefined, url: string) => Response) => {
      serverSays = rule;
    },
  };
}

describe("an expired access token", () => {
  it("is exchanged once for requests that expire together, each retried once with the new one", async () => {
    const app = world();
    app.says((token) => (token === "access-2" ? answer(200) : answer(401, "ACCESS_TOKEN_EXPIRED")));

    const responses = await Promise.all([app.call("/a"), app.call("/b"), app.call("/c")]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    // One exchange with the refresh token the session held, however many were waiting.
    expect(app.exchanges).toEqual(["refresh-1"]);
    // Each request went out twice: with the old token, then once with the new.
    for (const url of ["/a", "/b", "/c"]) {
      expect(app.calls.filter((entry) => entry.url === url).map((entry) => entry.token)).toEqual([
        "access-1",
        "access-2",
      ]);
    }
    expect(app.session?.accessToken).toBe("access-2");
    expect(app.session?.refreshToken).toBe("refresh-2");
    expect(app.ended).toBe(0);
  });

  it("is retried only once: a token that is expired again is the answer, not another exchange", async () => {
    const app = world();
    app.says(() => answer(401, "ACCESS_TOKEN_EXPIRED"));
    const response = await app.call("/a");
    expect(response.status).toBe(401);
    expect(app.exchanges).toHaveLength(1);
    expect(app.calls).toHaveLength(2);
  });

  it("is not exchanged again by a slow request whose token another request already replaced", async () => {
    const app = world();
    // The first request refreshed while this one was still on its way with the old token.
    app.setSession(session({ accessToken: "access-2", refreshToken: "refresh-2" }));
    app.says((token) => (token === "access-2" ? answer(200) : answer(401, "ACCESS_TOKEN_EXPIRED")));
    const response = await app.call("/late", "access-1");
    expect(response.status).toBe(200);
    expect(app.exchanges).toEqual([]);
    expect(app.calls.map((entry) => entry.token)).toEqual(["access-1", "access-2"]);
  });

  it("signs the app out, once, and answers SESSION_ENDED when the server refuses the exchange", async () => {
    const app = world({ exchange: () => Promise.resolve({ kind: "refused" }) });
    app.says(() => answer(401, "ACCESS_TOKEN_EXPIRED"));
    const [first, second] = await Promise.all([app.call("/a"), app.call("/b")]);
    for (const response of [first, second]) {
      expect(response.status).toBe(401);
      expect(((await response.json()) as { code: string }).code).toBe("SESSION_ENDED");
    }
    expect(app.exchanges).toHaveLength(1);
    expect(app.ended).toBe(1);
    expect(app.session).toBeNull();
  });

  it("keeps the session when the exchange could not be done — offline, a timeout, a server error", async () => {
    let reachable = false;
    const app = world({
      exchange: () =>
        Promise.resolve(reachable ? { kind: "ok", tokens: tokens(2) } : { kind: "unavailable" }),
    });
    app.says((token) => (token === "access-2" ? answer(200) : answer(401, "ACCESS_TOKEN_EXPIRED")));

    // The caller sees what any failed network request looks like to the client.
    await expect(app.call("/a")).rejects.toThrow(TypeError);
    expect(app.ended).toBe(0);
    expect(app.session?.refreshToken).toBe("refresh-1");

    // The network is back: the very next request exchanges and goes through.
    reachable = true;
    expect((await app.call("/a")).status).toBe(200);
    expect(app.exchanges).toEqual(["refresh-1", "refresh-1"]);
    expect(app.session?.accessToken).toBe("access-2");
  });

  it("does not end a sign-in that happened while an old exchange was refused", async () => {
    let finish: (value: ExchangeResult) => void = () => undefined;
    const app = world({
      exchange: () => new Promise<ExchangeResult>((resolve) => (finish = resolve)),
    });
    app.says(() => answer(401, "ACCESS_TOKEN_EXPIRED"));
    const pending = app.call("/a");
    await Promise.resolve();
    await Promise.resolve();
    app.setSession(
      session({ sessionId: "33333333-3333-4333-8333-333333333333", accessToken: "new" }),
    );
    finish({ kind: "refused" });
    await pending;
    expect(app.ended).toBe(0);
    expect(app.session?.accessToken).toBe("new");
  });
});

describe("the time of one attempt (TASK-029.B)", () => {
  /**
   * A server in fake time: the first answer says the token expired, the
   * exchange takes `exchangeMs`, a retry answers after `retryMs` — and every
   * request stops when its signal is aborted, like `fetch` does.
   */
  function slowWorld(options: { exchangeMs: number; retryMs: number; attemptTimeoutMs: number }) {
    vi.useFakeTimers();
    let current: StoredSession | null = session();
    const fetch = createSessionAwareFetch({
      attemptTimeoutMs: options.attemptTimeoutMs,
      fetch: (_input, init) => {
        const token = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
        if (token === "access-1") return Promise.resolve(answer(401, "ACCESS_TOKEN_EXPIRED"));
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(answer(200)), options.retryMs);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
      currentSession: () => current,
      renewSession: (_sessionId, next) => {
        if (current) current = { ...current, accessToken: next.accessToken };
      },
      endSession: () => {
        current = null;
      },
      exchange: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ kind: "ok", tokens: tokens(2) }), options.exchangeMs),
        ),
    });
    return { fetch };
  }

  it("lets the retry have its own time after a slow exchange", async () => {
    const { fetch } = slowWorld({ exchangeMs: 7_000, retryMs: 3_000, attemptTimeoutMs: 8_000 });
    try {
      const caller = new AbortController();
      const pending = fetch("/slow", {
        headers: { Authorization: "Bearer access-1" },
        signal: caller.signal,
      });
      await vi.advanceTimersByTimeAsync(10_500);
      // 7 s of exchange plus 3 s of retry — more than one attempt's 8 s, and it still answered.
      expect((await pending).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an attempt that takes longer than its time, and on the caller's cancel", async () => {
    const { fetch } = slowWorld({ exchangeMs: 0, retryMs: 20_000, attemptTimeoutMs: 8_000 });
    try {
      const tooLong = fetch("/slow", { headers: { Authorization: "Bearer access-1" } });
      const failed = expect(tooLong).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(8_001);
      await failed;

      const caller = new AbortController();
      const cancelled = fetch("/slow", {
        headers: { Authorization: "Bearer access-2" },
        signal: caller.signal,
      });
      const stopped = expect(cancelled).rejects.toThrow("aborted");
      caller.abort();
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a session the server has ended", () => {
  it("signs the app out at once on SESSION_ENDED, and hands the answer on as it came", async () => {
    const app = world();
    app.says(() => answer(401, "SESSION_ENDED"));
    const response = await app.call("/orders");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("SESSION_ENDED");
    expect(app.ended).toBe(1);
    expect(app.session).toBeNull();
    // No exchange to try: the session is over, whatever the refresh token says.
    expect(app.exchanges).toEqual([]);
  });

  it("does not sign out a newer sign-in because of a late answer to an old request", async () => {
    const app = world();
    app.setSession(session({ accessToken: "new-session-token" }));
    app.says(() => answer(401, "SESSION_ENDED"));
    await app.call("/orders", "token-of-the-ended-session");
    expect(app.ended).toBe(0);
    expect(app.session?.accessToken).toBe("new-session-token");
  });

  it("leaves other 401 answers alone — they are not the end of anything", async () => {
    const app = world();
    app.says(() => answer(401, "AUTH_REQUIRED"));
    expect((await app.call("/orders")).status).toBe(401);
    expect(app.ended).toBe(0);
    expect(app.exchanges).toEqual([]);
    app.says(() => answer(403, "FORBIDDEN"));
    expect((await app.call("/orders")).status).toBe(403);
    expect(app.ended).toBe(0);
  });
});

describe("what an exchange answered", () => {
  it("takes a valid pair, and nothing else that came back 200", async () => {
    expect(await exchangeResultOf(answerWith(200, tokens(5)))).toEqual({
      kind: "ok",
      tokens: tokens(5),
    });
    expect(await exchangeResultOf(answerWith(200, { accessToken: "x" }))).toEqual({
      kind: "unavailable",
    });
    expect(await exchangeResultOf(new Response("not json", { status: 200 }))).toEqual({
      kind: "unavailable",
    });
  });

  it("reads a refusal of the token as the end, and a slow or broken server as no verdict", async () => {
    for (const status of [400, 401, 403]) {
      expect(await exchangeResultOf(answer(status, "SESSION_ENDED")), String(status)).toEqual({
        kind: "refused",
      });
    }
    for (const status of [408, 429, 500, 502, 503]) {
      expect(await exchangeResultOf(answer(status)), String(status)).toEqual({
        kind: "unavailable",
      });
    }
  });
});

function answerWith(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
