import { describe, expect, it } from "vitest";
import { INITIAL_FIRST_RUN, parseFirstRun } from "./first-run";
import {
  decideStart,
  startLanguage,
  supportedSystemLanguage,
  type StartInput,
} from "./start-decision";

/** A returning user: language chosen, first run done, guest, online, no push. */
const RETURNING: StartInput = {
  policy: "supported",
  storedLanguage: "ru",
  systemLanguage: "ru",
  firstRun: { completed: true, step: "city" },
  session: "none",
  online: true,
  savedActiveOrders: false,
  push: null,
};

const FIRST_LAUNCH: StartInput = {
  ...RETURNING,
  storedLanguage: null,
  firstRun: { completed: false, step: "city" },
};

describe("decideStart — the order of SCREENS 5.1", () => {
  it("1. the server said an update is required → M-START-03", () => {
    expect(decideStart({ ...RETURNING, policy: "update-required" })).toEqual({
      screen: "update-required",
    });
  });

  it("1. beats every other rule, including an unfinished first run and a push", () => {
    expect(
      decideStart({
        ...FIRST_LAUNCH,
        policy: "update-required",
        session: "revoked",
        online: false,
        savedActiveOrders: true,
        push: { screen: "order", params: { id: "1" } },
      }),
    ).toEqual({ screen: "update-required" });
  });

  it("1. a 426 while the app is running switches the same decision to the update screen", () => {
    const running: StartInput = { ...RETURNING, policy: "supported" };
    expect(decideStart(running).screen).toBe("catalog");
    // The only thing that changed is the policy the gate reports.
    expect(decideStart({ ...running, policy: "update-required" }).screen).toBe("update-required");
  });

  it("2. no language chosen and a system kk/ru/en → applied silently, no language screen", () => {
    expect(decideStart({ ...FIRST_LAUNCH, systemLanguage: "kk" })).toEqual({
      screen: "first-run-city",
      applyLanguage: "kk",
    });
  });

  it("2. no language chosen and an unsupported system language → M-START-02", () => {
    expect(decideStart({ ...FIRST_LAUNCH, systemLanguage: null })).toEqual({ screen: "language" });
  });

  it("2. a chosen language is never asked about again", () => {
    expect(decideStart({ ...FIRST_LAUNCH, storedLanguage: "en", systemLanguage: null })).toEqual({
      screen: "first-run-city",
    });
  });

  it("3. the first run is not finished → its city step", () => {
    expect(decideStart({ ...RETURNING, firstRun: { completed: false, step: "city" } })).toEqual({
      screen: "first-run-city",
    });
  });

  it("3. the app closed mid-way through the first run returns to the step it stopped at", () => {
    expect(decideStart({ ...RETURNING, firstRun: { completed: false, step: "car" } })).toEqual({
      screen: "first-run-car",
    });
  });

  it("3. an unfinished first run beats a revoked session, being offline and a push", () => {
    expect(
      decideStart({
        ...RETURNING,
        firstRun: { completed: false, step: "city" },
        session: "revoked",
        online: false,
        savedActiveOrders: true,
        push: { screen: "order" },
      }),
    ).toEqual({ screen: "first-run-city" });
  });

  it("4. a revoked session → the catalog as a guest with the sheet", () => {
    expect(decideStart({ ...RETURNING, session: "revoked" })).toEqual({
      screen: "catalog",
      signedOutNotice: true,
    });
  });

  it("4. a revoked session beats being offline with saved orders and a push", () => {
    expect(
      decideStart({
        ...RETURNING,
        session: "revoked",
        online: false,
        savedActiveOrders: true,
        push: { screen: "order" },
      }),
    ).toEqual({ screen: "catalog", signedOutNotice: true });
  });

  it("5. offline, signed in and saved active orders → M-ORD-02 without a network", () => {
    expect(
      decideStart({ ...RETURNING, online: false, session: "active", savedActiveOrders: true }),
    ).toEqual({ screen: "orders-offline" });
  });

  it("5. offline without a saved copy, or as a guest, still opens the catalog", () => {
    expect(
      decideStart({ ...RETURNING, online: false, session: "active", savedActiveOrders: false })
        .screen,
    ).toBe("catalog");
    expect(
      decideStart({ ...RETURNING, online: false, session: "none", savedActiveOrders: true }).screen,
    ).toBe("catalog");
  });

  it("5. beats a push", () => {
    expect(
      decideStart({
        ...RETURNING,
        online: false,
        session: "active",
        savedActiveOrders: true,
        push: { screen: "order" },
      }),
    ).toEqual({ screen: "orders-offline" });
  });

  it("6. a push opens the screen it points at", () => {
    const push = { screen: "order", params: { orderId: "42" } };
    expect(decideStart({ ...RETURNING, push })).toEqual({ screen: "push", push });
  });

  it("7. otherwise the catalog", () => {
    expect(decideStart(RETURNING)).toEqual({ screen: "catalog" });
  });

  it("keeps the splash while the policy answer is still awaited", () => {
    expect(decideStart({ ...RETURNING, policy: "pending" })).toEqual({ screen: "splash" });
  });

  it("a 426 that arrives during that wait wins over the splash", () => {
    expect(decideStart({ ...RETURNING, policy: "update-required" }).screen).toBe("update-required");
  });

  it("the app does not wait for the server longer than that: without an answer it goes on", () => {
    // The caller reports `pending` for a couple of seconds and `unverified`
    // afterwards — from then on the order runs to the end as usual.
    expect(decideStart({ ...RETURNING, policy: "unverified" }).screen).toBe("catalog");
    expect(decideStart({ ...FIRST_LAUNCH, policy: "unverified", systemLanguage: "ru" })).toEqual({
      screen: "first-run-city",
      applyLanguage: "ru",
    });
  });

  it("an unverified policy (offline, server down) is not a reason to block either", () => {
    expect(decideStart({ ...RETURNING, policy: "unverified" }).screen).toBe("catalog");
  });

  it("the first launch without a network goes through the first run, not into an error", () => {
    expect(
      decideStart({ ...FIRST_LAUNCH, policy: "unverified", online: false, systemLanguage: "ru" }),
    ).toEqual({ screen: "first-run-city", applyLanguage: "ru" });
  });
});

describe("parseFirstRun", () => {
  it("starts unfinished at the city step", () => {
    expect(INITIAL_FIRST_RUN).toEqual({ completed: false, step: "city" });
  });

  it("reads both steps back", () => {
    expect(parseFirstRun({ completed: false, step: "car" })).toEqual({
      completed: false,
      step: "car",
    });
    expect(parseFirstRun({ completed: true, step: "city" })).toEqual({
      completed: true,
      step: "city",
    });
  });

  it("rejects anything unusable, so the first run starts over", () => {
    expect(parseFirstRun(null)).toBeNull();
    expect(parseFirstRun({ completed: true })).toBeNull();
    expect(parseFirstRun({ completed: true, step: "garage" })).toBeNull();
  });
});

describe("startLanguage", () => {
  it("prefers the choice on the device, then the system language, then Russian", () => {
    expect(startLanguage("en", "kk")).toBe("en");
    expect(startLanguage(null, "kk")).toBe("kk");
    expect(startLanguage(null, null)).toBe("ru");
  });
});

describe("supportedSystemLanguage", () => {
  it("accepts kk/ru/en with or without a region", () => {
    expect(supportedSystemLanguage("kk-KZ")).toBe("kk");
    expect(supportedSystemLanguage("ru")).toBe("ru");
    expect(supportedSystemLanguage("en-US")).toBe("en");
    expect(supportedSystemLanguage("ru_KZ")).toBe("ru");
  });

  it("returns null for anything else, so the app asks", () => {
    expect(supportedSystemLanguage("tr-TR")).toBeNull();
    expect(supportedSystemLanguage("uz")).toBeNull();
    expect(supportedSystemLanguage("")).toBeNull();
    expect(supportedSystemLanguage(null)).toBeNull();
    expect(supportedSystemLanguage(undefined)).toBeNull();
  });
});
