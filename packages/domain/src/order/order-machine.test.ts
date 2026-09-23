import { describe, expect, it } from "vitest";
import {
  activeOrderStatuses,
  isActiveOrderStatus,
  orderActionActor,
  orderActions,
  orderActionSources,
  orderStatuses,
  orderTransition,
  type OrderAction,
  type OrderStatus,
} from "./order-machine";

/** Every allowed move (PRODUCT 10.2, ARCHITECTURE 6.1); anything else is refused. */
const allowed: [OrderStatus, OrderAction, OrderStatus][] = [
  ["created", "accept", "accepted"],
  ["created", "decline", "declined_by_supplier"],
  ["accepted", "decline", "declined_by_supplier"],
  ["ready", "decline", "declined_by_supplier"],
  ["accepted", "mark_ready", "ready"],
  ["accepted", "close", "completed"],
  ["ready", "close", "completed"],
  ["created", "cancel", "cancelled_by_user"],
  ["accepted", "cancel", "cancelled_by_user"],
  ["ready", "cancel", "cancelled_by_user"],
  ["created", "expire_no_response", "response_expired"],
  ["accepted", "expire_reserve", "reserve_expired"],
  ["ready", "expire_reserve", "reserve_expired"],
];

describe("orderTransition", () => {
  it.each(allowed)("%s --%s--> %s", (from, action, to) => {
    expect(orderTransition(from, action)).toBe(to);
  });

  it("refuses every other move", () => {
    const key = (from: string, action: string) => `${from}/${action}`;
    const known = new Set(allowed.map(([from, action]) => key(from, action)));
    for (const from of orderStatuses) {
      for (const action of orderActions) {
        if (!known.has(key(from, action))) {
          expect(orderTransition(from, action), key(from, action)).toBeNull();
        }
      }
    }
  });

  it("never moves an order out of a final status", () => {
    for (const status of orderStatuses.filter((entry) => !isActiveOrderStatus(entry))) {
      for (const action of orderActions) {
        expect(orderTransition(status, action)).toBeNull();
      }
    }
  });

  it("closes straight from «accepted» (D-040) and gives no other way to «completed»", () => {
    expect(orderTransition("accepted", "close")).toBe("completed");
    expect(orderTransition("created", "close")).toBeNull();
  });

  it("names the sources and the actor of each action", () => {
    expect(orderActionSources("accept")).toEqual(["created"]);
    expect(orderActionSources("cancel")).toEqual(["created", "accepted", "ready"]);
    expect(orderActionActor.accept).toBe("supplier");
    expect(orderActionActor.cancel).toBe("user");
    expect(orderActionActor.expire_reserve).toBe("system");
  });

  it("keeps the active statuses those an order still goes through", () => {
    expect([...activeOrderStatuses]).toEqual(["created", "accepted", "ready"]);
    expect(isActiveOrderStatus("ready")).toBe(true);
    expect(isActiveOrderStatus("reserve_expired")).toBe(false);
  });
});
