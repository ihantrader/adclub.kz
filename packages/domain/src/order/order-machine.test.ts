import { describe, expect, it } from "vitest";
import {
  activeOrderStatuses,
  awaitingReceiptOrderStatuses,
  isActiveOrderStatus,
  orderActionActor,
  orderActions,
  orderActionSources,
  orderAwaitsReceipt,
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
  // TASK-022: the late close of an expired reserve and the administrator's
  // close without a code.
  ["reserve_expired", "close_late", "completed"],
  ["created", "admin_close", "completed"],
  ["accepted", "admin_close", "completed"],
  ["ready", "admin_close", "completed"],
  ["response_expired", "admin_close", "completed"],
  ["reserve_expired", "admin_close", "completed"],
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

  it("moves an order out of a final status only by a late close or the administrator", () => {
    for (const status of orderStatuses.filter((entry) => !isActiveOrderStatus(entry))) {
      for (const action of orderActions) {
        if (action === "close_late" || action === "admin_close") {
          continue;
        }
        expect(orderTransition(status, action), `${status}/${action}`).toBeNull();
      }
    }
    // Neither of the two touches an order already given out, cancelled or declined.
    for (const status of ["completed", "cancelled_by_user", "declined_by_supplier"] as const) {
      expect(orderTransition(status, "close_late")).toBeNull();
      expect(orderTransition(status, "admin_close")).toBeNull();
    }
    // An order the supplier never answered is never closed late (PRODUCT 10.7).
    expect(orderTransition("response_expired", "close_late")).toBeNull();
  });

  it("closes straight from «accepted» (D-040) and gives no other way to «completed»", () => {
    expect(orderTransition("accepted", "close")).toBe("completed");
    expect(orderTransition("created", "close")).toBeNull();
    // Exactly three moves reach «completed»: the code or the QR of the
    // company's own employee (in time or late) and the administrator.
    const toCompleted = orderActions.filter((action) =>
      orderStatuses.some((from) => orderTransition(from, action) === "completed"),
    );
    expect([...toCompleted]).toEqual(["close", "close_late", "admin_close"]);
  });

  it("names the sources and the actor of each action", () => {
    expect(orderActionSources("accept")).toEqual(["created"]);
    expect(orderActionSources("cancel")).toEqual(["created", "accepted", "ready"]);
    expect(orderActionSources("close_late")).toEqual(["reserve_expired"]);
    expect(orderActionActor.accept).toBe("supplier");
    expect(orderActionActor.cancel).toBe("user");
    expect(orderActionActor.expire_reserve).toBe("system");
    expect(orderActionActor.close_late).toBe("supplier");
    expect(orderActionActor.admin_close).toBe("admin");
  });

  it("keeps the active statuses those an order still goes through", () => {
    expect([...activeOrderStatuses]).toEqual(["created", "accepted", "ready"]);
    expect(isActiveOrderStatus("ready")).toBe(true);
    expect(isActiveOrderStatus("reserve_expired")).toBe(false);
  });

  it("marks apart the active orders awaiting a receipt (PRODUCT 6.7)", () => {
    expect([...awaitingReceiptOrderStatuses]).toEqual(["accepted", "ready"]);
    // A subset of the active ones, never a second definition of «active».
    for (const status of awaitingReceiptOrderStatuses) {
      expect(isActiveOrderStatus(status), status).toBe(true);
    }
    expect(orderAwaitsReceipt("created")).toBe(false);
    expect(orderAwaitsReceipt("accepted")).toBe(true);
    expect(orderAwaitsReceipt("completed")).toBe(false);
    for (const status of orderStatuses.filter((entry) => !isActiveOrderStatus(entry))) {
      expect(orderAwaitsReceipt(status), status).toBe(false);
    }
  });
});
