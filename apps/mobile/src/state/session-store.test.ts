import { describe, expect, it } from "vitest";
import type { DeviceStorage } from "./device-store";
import {
  createSessionStore,
  parseSessionState,
  SIGNED_OUT,
  type StoredSession,
} from "./session-store";

function memoryStorage(initial: Record<string, string> = {}): DeviceStorage & {
  written: Record<string, string>;
} {
  const written = { ...initial };
  return {
    written,
    read: (key) => Promise.resolve(written[key] ?? null),
    write: (key, value) => {
      written[key] = value;
      return Promise.resolve();
    },
  };
}

const SESSION: StoredSession = {
  accountId: "11111111-1111-1111-1111-111111111111",
  sessionId: "22222222-2222-2222-2222-222222222222",
  kind: "mobile",
  accessToken: "access-token",
  accessTokenExpiresAt: "2026-09-27T10:00:00.000Z",
  refreshToken: "refresh-token",
  sessionExpiresAt: "2026-12-25T10:00:00.000Z",
};

describe("parseSessionState", () => {
  it("reads a signed-out value", () => {
    expect(parseSessionState({ status: "signed_out" })).toEqual(SIGNED_OUT);
  });

  it("reads a signed-in value with a full session", () => {
    expect(parseSessionState({ status: "signed_in", session: SESSION })).toEqual({
      status: "signed_in",
      session: SESSION,
    });
  });

  it("rejects a signed-in value missing a field (never a half-usable session)", () => {
    const { refreshToken: _dropped, ...incomplete } = SESSION;
    expect(parseSessionState({ status: "signed_in", session: incomplete })).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseSessionState(null)).toBeNull();
    expect(parseSessionState("mobile")).toBeNull();
    expect(parseSessionState({ status: "whatever" })).toBeNull();
  });
});

describe("createSessionStore", () => {
  it("starts signed out and applies a stored session once read", async () => {
    const store = createSessionStore(
      memoryStorage({
        "adclub.mobile.session": JSON.stringify({ status: "signed_in", session: SESSION }),
      }),
    );
    expect(store.get()).toEqual(SIGNED_OUT);
    await store.ready;
    expect(store.get()).toEqual({ status: "signed_in", session: SESSION });
  });

  it("a corrupted stored value is ignored, not thrown — the app stays a guest", async () => {
    const store = createSessionStore(memoryStorage({ "adclub.mobile.session": "{not json" }));
    await store.ready;
    expect(store.get()).toEqual(SIGNED_OUT);
  });

  it("signing out persists and can be read back as signed out", async () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    store.set({ status: "signed_in", session: SESSION });
    expect(JSON.parse(storage.written["adclub.mobile.session"]!)).toEqual({
      status: "signed_in",
      session: SESSION,
    });
    store.set(SIGNED_OUT);
    expect(JSON.parse(storage.written["adclub.mobile.session"]!)).toEqual(SIGNED_OUT);
    expect(store.get()).toEqual(SIGNED_OUT);
  });
});
