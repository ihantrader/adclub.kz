import { beforeEach, describe, expect, it } from "vitest";
import {
  catalogCarDecision,
  pendingCatalogCar,
  requestCatalogCar,
  subscribeCatalogCarRequest,
  takeCatalogCarRequest,
} from "./catalog-car-request";

describe("catalogCarDecision (TASK-069.A)", () => {
  it.each([
    ["the garage is loading, the car is not there yet", { loaded: false, carIds: [] }, "wait"],
    [
      "the garage is loading, the copy has the car",
      { loaded: false, carIds: ["coolray"] },
      "apply",
    ],
    ["the garage loaded with the car", { loaded: true, carIds: ["atlas", "coolray"] }, "apply"],
    ["the garage loaded without it (deleted)", { loaded: true, carIds: ["atlas"] }, "drop"],
  ] as const)("%s → %s", (_, garage, expected) => {
    expect(catalogCarDecision("coolray", garage)).toBe(expected);
  });
});

describe("the request of a push from a cold start", () => {
  beforeEach(() => {
    // Whatever an earlier case left: a loaded garage drops it.
    takeCatalogCarRequest({ loaded: true, carIds: [] });
  });

  it("waits while the garage loads, then the car becomes the header's", () => {
    let notified = 0;
    const off = subscribeCatalogCarRequest(() => notified++);
    requestCatalogCar("coolray");
    expect(notified).toBe(1);
    expect(takeCatalogCarRequest({ loaded: false, carIds: ["atlas"] })).toBeNull();
    expect(pendingCatalogCar()).toBe("coolray");
    expect(takeCatalogCarRequest({ loaded: true, carIds: ["atlas", "coolray"] })).toBe("coolray");
    expect(pendingCatalogCar()).toBeNull();
    // Taken once: the next change of the garage applies nothing.
    expect(takeCatalogCarRequest({ loaded: true, carIds: ["atlas", "coolray"] })).toBeNull();
    off();
  });

  it("a deleted car: dropped silently once the garage has loaded", () => {
    requestCatalogCar("coolray");
    expect(takeCatalogCarRequest({ loaded: true, carIds: ["atlas"] })).toBeNull();
    expect(pendingCatalogCar()).toBeNull();
  });

  it("a newer push replaces the one that waits", () => {
    requestCatalogCar("coolray");
    requestCatalogCar("atlas");
    expect(takeCatalogCarRequest({ loaded: true, carIds: ["atlas", "coolray"] })).toBe("atlas");
  });
});
