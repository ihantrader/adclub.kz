import { describe, expect, it } from "vitest";
import {
  createWebSession,
  exchangeVerdictOf,
  type ExchangeVerdict,
  type TabChannel,
  type TabLock,
  type TabMessage,
  type WebTokens,
} from "./web-session-core";

const SESSION = "4b0a1c35-8d7e-4d55-9a7e-5d1f0f6c9a11";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearer(init: RequestInit): string | undefined {
  return new Headers(init.headers).get("Authorization")?.replace("Bearer ", "");
}

/**
 * The server's side of one cabinet session (ARCHITECTURE 4.6 I49): one
 * cookie for the whole browser, rotation on every exchange, the same pair
 * for a repeated exchange of the previous generation within the grace
 * period, and the end of the session for anything older.
 */
class FakeServer {
  generation = 1;
  rotatedAt = -Infinity;
  /** What the browser's cookie jar holds: shared by every tab. */
  cookie = 1;
  revoked: "SESSION_ENDED" | "SUPPLIER_ACCESS_CLOSED" | null = null;
  exchanges = 0;
  validTokens = new Set<string>();
  graceMs = 60_000;
  clock = 0;
  offline = false;

  tokenOf(generation: number, serial: number): string {
    return `at-${generation}-${serial}`;
  }

  /** `POST /auth/session/refresh` with the cookie the browser holds right now. */
  async exchange(): Promise<ExchangeVerdict> {
    if (this.offline) return { kind: "unavailable" };
    this.exchanges += 1;
    const presented = this.cookie;
    // Answer after a turn of the event loop, like a real request.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.revoked) {
      return exchangeVerdictOf(json(401, { code: this.revoked, message: "", retryable: false }));
    }
    if (presented === this.generation) {
      this.generation += 1;
      this.rotatedAt = this.clock;
    } else if (presented === this.generation - 1 && this.clock - this.rotatedAt <= this.graceMs) {
      // A repeat of the same exchange: the same pair.
    } else {
      this.revoked = "SESSION_ENDED";
      return exchangeVerdictOf(json(401, { code: "SESSION_ENDED", message: "", retryable: false }));
    }
    this.cookie = this.generation;
    const token = this.tokenOf(this.generation, this.exchanges);
    this.validTokens.add(token);
    return exchangeVerdictOf(
      json(200, {
        sessionId: SESSION,
        kind: "supplier_web",
        accessToken: token,
        accessTokenExpiresAt: new Date(Date.now() + 900_000 + this.exchanges).toISOString(),
        sessionExpiresAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
      }),
    );
  }

  /** Any protected route. */
  async handle(_input: string, init: RequestInit): Promise<Response> {
    if (this.offline) throw new TypeError("Failed to fetch");
    await new Promise((resolve) => setTimeout(resolve, 1));
    const token = bearer(init);
    if (this.revoked) return json(401, { code: this.revoked, message: "", retryable: false });
    if (!token || !this.validTokens.has(token)) {
      return json(401, { code: "ACCESS_TOKEN_EXPIRED", message: "", retryable: false });
    }
    return json(200, { ok: true, token });
  }

  expireAll(): void {
    this.validTokens.clear();
  }
}

/** BroadcastChannel semantics: every other tab gets the message, never the sender. */
class FakeBroadcast {
  private tabs = new Set<(message: TabMessage) => void>();

  channel(): TabChannel {
    const own = new Set<(message: TabMessage) => void>();
    const deliver = (message: TabMessage) => own.forEach((listener) => listener(message));
    this.tabs.add(deliver);
    return {
      post: (message) => {
        for (const tab of this.tabs) {
          if (tab !== deliver) queueMicrotask(() => tab(structuredClone(message)));
        }
      },
      subscribe: (listener) => {
        own.add(listener);
        return () => own.delete(listener);
      },
    };
  }
}

/** Web Locks semantics: one holder at a time, in request order. */
function fakeLock(): TabLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

function tab(server: FakeServer, extra: { channel?: TabChannel; lock?: TabLock } = {}) {
  return createWebSession({
    fetch: (input, init) => server.handle(input, init),
    exchange: () => server.exchange(),
    peerWaitMs: 20,
    ...extra,
  });
}

async function call(session: ReturnType<typeof tab>): Promise<Response> {
  const token = session.accessToken();
  return session.fetch("https://api.test/supplier/company", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("starting a page", () => {
  it("is signed in by the cookie alone: a reopened tab needs no sign-in", async () => {
    const server = new FakeServer();
    const session = tab(server);
    expect(session.state().status).toBe("starting");
    await session.start();
    expect(session.state().status).toBe("signed_in");
    expect((await call(session)).status).toBe(200);
  });

  it("shows the plain sign-in without a cookie, the reason of an ended session otherwise", async () => {
    const none = createWebSession({
      fetch: () => Promise.reject(new Error("unused")),
      exchange: () =>
        exchangeVerdictOf(json(401, { code: "AUTH_REQUIRED", message: "", retryable: false })),
    });
    await none.start();
    expect(none.state()).toEqual({ status: "signed_out", reason: "none" });

    const server = new FakeServer();
    server.revoked = "SUPPLIER_ACCESS_CLOSED";
    const closed = tab(server);
    await closed.start();
    expect(closed.state()).toEqual({ status: "signed_out", reason: "access_closed" });
  });

  it("does not decide anything when the server can't be reached", async () => {
    const server = new FakeServer();
    server.offline = true;
    const session = tab(server);
    await session.start();
    expect(session.state().status).toBe("unreachable");
    server.offline = false;
    await session.start();
    expect(session.state().status).toBe("signed_in");
  });

  it("takes the token of an open tab instead of rotating the cookie again", async () => {
    const server = new FakeServer();
    const broadcast = new FakeBroadcast();
    const lock = fakeLock();
    const first = tab(server, { channel: broadcast.channel(), lock });
    await first.start();
    const second = tab(server, { channel: broadcast.channel(), lock });
    await second.start();
    expect(second.accessToken()).toBe(first.accessToken());
    expect(server.exchanges).toBe(1);
  });
});

describe("an expired access token", () => {
  it("is exchanged once for every request that expired together, and each is retried", async () => {
    const server = new FakeServer();
    const session = tab(server);
    await session.start();
    server.expireAll();
    const responses = await Promise.all([call(session), call(session), call(session)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(server.exchanges).toBe(2);
    expect(session.state().status).toBe("signed_in");
  });

  it("does not knock out either of two tabs that expire at once", async () => {
    const server = new FakeServer();
    const broadcast = new FakeBroadcast();
    const lock = fakeLock();
    const first = tab(server, { channel: broadcast.channel(), lock });
    const second = tab(server, { channel: broadcast.channel(), lock });
    await first.start();
    await second.start();
    for (let round = 0; round < 5; round += 1) {
      server.expireAll();
      const responses = await Promise.all([call(first), call(second), call(first), call(second)]);
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    }
    expect(first.state().status).toBe("signed_in");
    expect(second.state().status).toBe("signed_in");
    expect(server.revoked).toBeNull();
    // One start, then one exchange per round: the second tab takes the token.
    expect(server.exchanges).toBe(6);
  });

  it("survives two tabs without locks and messages: the server's grace covers them", async () => {
    const server = new FakeServer();
    const first = tab(server);
    const second = tab(server);
    await first.start();
    await second.start();
    server.expireAll();
    const responses = await Promise.all([call(first), call(second)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(server.revoked).toBeNull();
  });

  it("is not a sign-out when the exchange can't reach the server", async () => {
    const server = new FakeServer();
    const session = tab(server);
    await session.start();
    server.expireAll();
    const exchange = server.exchange.bind(server);
    server.exchange = async () => ({ kind: "unavailable" });
    await expect(call(session)).rejects.toThrow(TypeError);
    expect(session.state().status).toBe("signed_in");
    // The next request tries again.
    server.exchange = exchange;
    expect((await call(session)).status).toBe(200);
  });

  it("signs out with the server's reason when the exchange is refused", async () => {
    const server = new FakeServer();
    const session = tab(server);
    await session.start();
    server.expireAll();
    server.exchange = () =>
      exchangeVerdictOf(json(401, { code: "SESSION_ENDED", message: "", retryable: false }));
    const response = await call(session);
    expect(response.status).toBe(401);
    expect(session.state()).toEqual({ status: "signed_out", reason: "session_ended" });
  });

  it("reports an update required by the exchange instead of signing out", async () => {
    const server = new FakeServer();
    const told: string[] = [];
    const session = createWebSession({
      fetch: (input, init) => server.handle(input, init),
      exchange: () => server.exchange(),
      onUpdateRequired: (message) => told.push(message),
    });
    await session.start();
    server.expireAll();
    server.exchange = () =>
      exchangeVerdictOf(
        json(426, { code: "CLIENT_UPDATE_REQUIRED", message: "Обновите", retryable: false }),
      );
    expect((await call(session)).status).toBe(426);
    expect(told).toEqual(["Обновите"]);
    expect(session.state().status).toBe("signed_in");
  });
});

describe("the server ends the session", () => {
  it("signs out every tab with «Доступ к кабинету закрыт» when the employee is removed", async () => {
    const server = new FakeServer();
    const broadcast = new FakeBroadcast();
    const first = tab(server, { channel: broadcast.channel() });
    const second = tab(server, { channel: broadcast.channel() });
    await first.start();
    await second.start();
    server.revoked = "SUPPLIER_ACCESS_CLOSED";
    expect((await call(first)).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.state()).toEqual({ status: "signed_out", reason: "access_closed" });
    expect(second.state()).toEqual({ status: "signed_out", reason: "access_closed" });
  });

  it("shows T-SES-01 for SESSION_ENDED on any request", async () => {
    const server = new FakeServer();
    const session = tab(server);
    await session.start();
    server.revoked = "SESSION_ENDED";
    await call(session);
    expect(session.state()).toEqual({ status: "signed_out", reason: "session_ended" });
  });

  it("ignores a late refusal of an older token once a new sign-in happened", async () => {
    const server = new FakeServer();
    const session = tab(server);
    await session.start();
    const old = session.accessToken()!;
    session.signedIn({
      sessionId: "1d4e2f53-0000-4000-8000-000000000001",
      accessToken: "new",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    server.revoked = "SESSION_ENDED";
    const late = await session.fetch("https://api.test/x", {
      headers: { Authorization: `Bearer ${old}` },
    });
    expect(late.status).toBe(401);
    expect(session.state().status).toBe("signed_in");
  });

  it("passes sign-in steps and public routes through untouched", async () => {
    const session = createWebSession({
      fetch: async () => json(401, { code: "SIGN_IN_STEP_INVALID", message: "", retryable: false }),
      exchange: async () => ({ kind: "unavailable" }),
    });
    const response = await session.fetch("https://api.test/auth/sign-in/supplier", {});
    expect(response.status).toBe(401);
    expect(session.state().status).toBe("starting");
  });
});

describe("tabs of one browser", () => {
  it("follow an explicit sign-out and a sign-in made in another tab", async () => {
    const server = new FakeServer();
    const broadcast = new FakeBroadcast();
    const lock = fakeLock();
    const first = tab(server, { channel: broadcast.channel(), lock });
    const second = tab(server, { channel: broadcast.channel(), lock });
    await first.start();
    await second.start();

    first.signOut("none");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.state()).toEqual({ status: "signed_out", reason: "none" });

    const tokens: WebTokens = {
      sessionId: SESSION,
      accessToken: "fresh",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
    server.validTokens.add("fresh");
    first.signedIn(tokens);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.state()).toEqual({ status: "signed_in", tokens });
  });

  it("tells the other tabs about a switch of company", async () => {
    const server = new FakeServer();
    const broadcast = new FakeBroadcast();
    let switched = 0;
    const first = tab(server, { channel: broadcast.channel() });
    const second = createWebSession({
      fetch: (input, init) => server.handle(input, init),
      exchange: () => server.exchange(),
      channel: broadcast.channel(),
      onContextChanged: () => (switched += 1),
    });
    await first.start();
    await second.start();
    first.contextChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switched).toBe(1);
  });
});

describe("exchangeVerdictOf", () => {
  it("reads what is a verdict about the session and what is not", async () => {
    const error = (status: number, code: string) =>
      exchangeVerdictOf(json(status, { code, message: "m", retryable: false }));
    expect(await error(401, "AUTH_REQUIRED")).toEqual({ kind: "ended", reason: "none" });
    expect(await error(401, "SESSION_ENDED")).toEqual({ kind: "ended", reason: "session_ended" });
    expect(await error(401, "SUPPLIER_ACCESS_CLOSED")).toEqual({
      kind: "ended",
      reason: "access_closed",
    });
    expect(await error(403, "ORIGIN_NOT_ALLOWED")).toEqual({ kind: "unavailable" });
    expect(await error(429, "RATE_LIMITED")).toEqual({ kind: "unavailable" });
    expect(await error(503, "SERVICE_UNAVAILABLE")).toEqual({ kind: "unavailable" });
    expect(await error(426, "CLIENT_UPDATE_REQUIRED")).toEqual({
      kind: "update_required",
      message: "m",
    });
    expect(await exchangeVerdictOf(new Response("<html>", { status: 502 }))).toEqual({
      kind: "unavailable",
    });
    expect(await exchangeVerdictOf(json(200, { nonsense: true }))).toEqual({
      kind: "unavailable",
    });
  });
});
