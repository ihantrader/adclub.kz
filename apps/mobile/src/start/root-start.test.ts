import { describe, expect, it } from "vitest";
import { rootStart } from "./root-start";
import { decideStart, type StartInput } from "./start-decision";

const RETURNING: StartInput = {
  policy: "supported",
  storedLanguage: "ru",
  systemLanguage: "ru",
  firstRun: { completed: true, step: "car" },
  hasCar: true,
  session: "none",
  online: true,
  savedActiveOrders: false,
  push: null,
};

describe("where the root stack opens", () => {
  it("opens the first run on the step the decision names", () => {
    expect(rootStart("first-run-city")).toEqual({ screen: "first-run-city" });
    expect(rootStart("first-run-car")).toEqual({ screen: "first-run-car" });
  });

  it("opens the tabs on the catalog, or on the orders without a network", () => {
    expect(rootStart("catalog")).toEqual({ screen: "tabs", tab: "catalog" });
    expect(rootStart("push")).toEqual({ screen: "tabs", tab: "catalog" });
    expect(rootStart("orders-offline")).toEqual({ screen: "tabs", tab: "orders" });
  });

  it("leaves the gates out: the splash, the update screen and the language are not steps in it", () => {
    expect(rootStart("splash")).toBeNull();
    expect(rootStart("update-required")).toBeNull();
    expect(rootStart("language")).toBeNull();
  });

  it("follows the decision of a clean install: city, then the car, then the tabs", () => {
    const clean: StartInput = {
      ...RETURNING,
      firstRun: { completed: false, step: "city" },
      hasCar: false,
    };
    expect(rootStart(decideStart(clean).screen)).toEqual({ screen: "first-run-city" });
    // The city was chosen and the app closed: it opens on the car step again.
    const atCar: StartInput = { ...clean, firstRun: { completed: false, step: "car" } };
    expect(rootStart(decideStart(atCar).screen)).toEqual({ screen: "first-run-car" });
    // The car was added: the first run is over.
    expect(rootStart(decideStart({ ...atCar, hasCar: true }).screen)).toEqual({
      screen: "tabs",
      tab: "catalog",
    });
  });
});
