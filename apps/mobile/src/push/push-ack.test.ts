import { ApiError, createApiClient } from "@adclub/api-client";
import type { SessionTokens } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { createSessionAwareFetch } from "../services/session-fetch-core";
import type { StoredSession } from "../state/session-store";
import {
  ackOutcomeOf,
  notificationIdOfTask,
  parsePendingAcks,
  PENDING_ACKS_LIMIT,
  runBackgroundAck,
  withoutPendingAck,
  withPendingAck,
} from "./push-ack";

const ID = "8d3f0a4c-7b1e-4d2a-9f3c-1e2d3c4b5a69";
const ORDER = "1d2c3b4a-5e6f-4a1b-8c9d-0e1f2a3b4c5d";
const TARGET = JSON.stringify({ screen: "order", params: { orderId: ORDER } });

const apiError = (status: number, code = "INTERNAL_ERROR") =>
  new ApiError({ code: code as never, message: code, status, retryable: status >= 500 });

describe("what a failed confirmation becomes (I866)", () => {
  it("a 4xx is not asked again; no network, 5xx, 408 and 429 are", () => {
    expect(ackOutcomeOf(undefined)).toBe("done");
    expect(ackOutcomeOf(apiError(404, "NOT_FOUND"))).toBe("drop");
    expect(ackOutcomeOf(apiError(401, "SESSION_ENDED"))).toBe("drop");
    expect(ackOutcomeOf(apiError(400, "VALIDATION_ERROR"))).toBe("drop");
    expect(ackOutcomeOf(apiError(0, "NETWORK_ERROR"))).toBe("retry");
    expect(ackOutcomeOf(apiError(503))).toBe("retry");
    expect(ackOutcomeOf(apiError(408))).toBe("retry");
    expect(ackOutcomeOf(apiError(429, "RATE_LIMITED"))).toBe("retry");
    expect(ackOutcomeOf(new TypeError("Network request failed"))).toBe("retry");
  });

  it("keeps a bounded queue of ids, once each", () => {
    let list = parsePendingAcks([ID, ID, "junk", 5]);
    expect(list).toEqual([ID]);
    list = withPendingAck(list, ID);
    expect(list).toEqual([ID]);
    expect(withoutPendingAck(list, ID)).toEqual([]);
    const many = Array.from(
      { length: PENDING_ACKS_LIMIT + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(parsePendingAcks(many)).toHaveLength(PENDING_ACKS_LIMIT);
    expect(parsePendingAcks(many).at(-1)).toBe(many.at(-1));
  });
});

describe("the payload of the background task (SDK 57)", () => {
  it("finds our id in Android's data, in dataString, in the iOS payload and in a tap", () => {
    expect(
      notificationIdOfTask({ notification: null, data: { notificationId: ID, target: TARGET } }),
    ).toBe(ID);
    expect(
      notificationIdOfTask({
        notification: null,
        data: { dataString: JSON.stringify({ notificationId: ID, target: TARGET }) },
      }),
    ).toBe(ID);
    expect(
      notificationIdOfTask({
        notification: null,
        data: { body: { notificationId: ID, target: TARGET } },
        aps: { "content-available": 1 },
      }),
    ).toBe(ID);
    expect(
      notificationIdOfTask({
        actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
        notification: { request: { content: { data: { notificationId: ID, target: TARGET } } } },
      }),
    ).toBe(ID);
    expect(
      notificationIdOfTask({ notification: null, data: { notificationId: "nope" } }),
    ).toBeNull();
    expect(notificationIdOfTask(null)).toBeNull();
  });
});

const SESSION: StoredSession = {
  accountId: "22222222-2222-4222-8222-222222222222",
  sessionId: "11111111-1111-4111-8111-111111111111",
  kind: "mobile",
  accessToken: "access-old",
  accessTokenExpiresAt: "2026-11-09T10:00:00.000Z",
  refreshToken: "refresh-1",
  sessionExpiresAt: "2026-12-09T10:00:00.000Z",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The app's API client over the real exchange rule, with a server in memory. */
function backgroundWorld(server: (token: string | undefined) => Response) {
  let session: StoredSession | null = { ...SESSION };
  const exchanges: string[] = [];
  const later: string[] = [];
  let ended = 0;
  const fetch = createSessionAwareFetch({
    fetch: (_input, init) =>
      Promise.resolve(
        server(new Headers(init.headers).get("Authorization")?.replace("Bearer ", "")),
      ),
    currentSession: () => session,
    renewSession: (_id, tokens: SessionTokens) => {
      if (session) session = { ...session, accessToken: tokens.accessToken };
    },
    endSession: () => {
      ended += 1;
      session = null;
    },
    exchange: (refresh) => {
      exchanges.push(refresh);
      return Promise.resolve({
        kind: "ok",
        tokens: {
          sessionId: SESSION.sessionId,
          kind: "mobile",
          accessToken: "access-new",
          accessTokenExpiresAt: "2026-11-09T11:00:00.000Z",
          refreshToken: "refresh-2",
          sessionExpiresAt: "2026-12-09T10:00:00.000Z",
        },
      });
    },
  });
  const api = createApiClient({
    baseUrl: "http://api.test",
    client: { platform: "ios", version: "1.0.0" },
    getAccessToken: () => session?.accessToken,
    fetch,
  });
  const deps = {
    signedIn: () => Promise.resolve(session !== null),
    ack: async (notificationId: string) => {
      await api.ackNotification({ notificationId });
    },
    later: (id: string) => {
      later.push(id);
    },
  };
  return {
    deps,
    exchanges,
    later,
    ended: () => ended,
    signOut: () => (session = null),
  };
}

const payload = { notification: null, data: { notificationId: ID, target: TARGET } };
const acked = () => json(200, { notificationId: ID, ackedAt: "2026-11-09T10:00:00.000Z" });

describe("the background confirmation (TASK-056 requirement 4)", () => {
  it("confirms a push that arrived while the app was closed", async () => {
    const world = backgroundWorld(() => acked());
    expect(await runBackgroundAck(payload, world.deps)).toBe("acked");
    expect(world.later).toEqual([]);
  });

  it("does nothing without a session, and nothing for a push not ours", async () => {
    let calls = 0;
    const world = backgroundWorld(() => {
      calls += 1;
      return acked();
    });
    world.signOut();
    expect(await runBackgroundAck(payload, world.deps)).toBe("signed_out");
    expect(await runBackgroundAck({ data: {} }, world.deps)).toBe("not_ours");
    expect(calls).toBe(0);
  });

  it("exchanges an expired access token once and confirms with the new one", async () => {
    const world = backgroundWorld((token) =>
      token === "access-old"
        ? json(401, { code: "ACCESS_TOKEN_EXPIRED", message: "expired", retryable: true })
        : acked(),
    );
    expect(await runBackgroundAck(payload, world.deps)).toBe("acked");
    expect(world.exchanges).toEqual(["refresh-1"]);
  });

  it("SESSION_ENDED signs the device out and confirms nothing later", async () => {
    const world = backgroundWorld(() =>
      json(401, { code: "SESSION_ENDED", message: "ended", retryable: false }),
    );
    expect(await runBackgroundAck(payload, world.deps)).toBe("dropped");
    expect(world.ended()).toBe(1);
    expect(world.later).toEqual([]);
  });

  it("a 4xx is dropped; no network or a 5xx waits for the app", async () => {
    expect(
      await runBackgroundAck(
        payload,
        backgroundWorld(() => json(404, { code: "NOT_FOUND", message: "no", retryable: false }))
          .deps,
      ),
    ).toBe("dropped");
    const down = backgroundWorld(() =>
      json(503, { code: "SERVICE_UNAVAILABLE", message: "down", retryable: true }),
    );
    expect(await runBackgroundAck(payload, down.deps)).toBe("later");
    expect(down.later).toEqual([ID]);
    const offline = backgroundWorld(() => {
      throw new TypeError("Network request failed");
    });
    expect(await runBackgroundAck(payload, offline.deps)).toBe("later");
    expect(offline.later).toEqual([ID]);
  });
});
