import { describe, expect, it } from "vitest";
import {
  activeOrderStatuses,
  answerAwaitingOrderStatuses,
  awaitingReceiptOrderStatuses,
  isActiveOrderStatus,
  orderActionActor,
  orderActions,
  orderActionSources,
  orderAwaitsReceipt,
  orderKinds,
  orderNeedsAnswer,
  orderStatuses,
  orderTransition,
  type OrderAction,
  type OrderKind,
  type OrderStatus,
} from "./order-machine";

type Allowed = [OrderStatus, OrderAction, OrderStatus][];

/** Every allowed move of an order on an item in stock (PRODUCT 10.2, ARCHITECTURE 6.1); anything else is refused. */
const stockAllowed: Allowed = [
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
  // TASK-036.B: the administrator cancels an order still going on.
  ["created", "admin_cancel", "cancelled_by_admin"],
  ["accepted", "admin_cancel", "cancelled_by_admin"],
  ["ready", "admin_cancel", "cancelled_by_admin"],
];

/**
 * Every allowed move of an order on an item to order (PRODUCT 10.3,
 * ARCHITECTURE 6.2, TASK-037); anything else is refused.
 */
const onOrderAllowed: Allowed = [
  // «Подтвердить срок» — the term the user agreed to when ordering.
  ["created", "accept", "accepted"],
  ["created", "propose_term", "term_proposed"],
  ["term_proposed", "agree_term", "accepted"],
  ["term_proposed", "reject_term", "cancelled_by_user"],
  ["term_proposed", "expire_term", "term_expired"],
  ["created", "decline", "declined_by_supplier"],
  // D-072 (TASK-039): while the user thinks the term over.
  ["term_proposed", "decline", "declined_by_supplier"],
  ["accepted", "decline", "declined_by_supplier"],
  ["ready", "decline", "declined_by_supplier"],
  ["accepted", "mark_ready", "ready"],
  ["accepted", "close", "completed"],
  ["ready", "close", "completed"],
  ["created", "cancel", "cancelled_by_user"],
  ["term_proposed", "cancel", "cancelled_by_user"],
  ["accepted", "cancel", "cancelled_by_user"],
  ["ready", "cancel", "cancelled_by_user"],
  ["created", "expire_no_response", "response_expired"],
  // Only the reserve «Готово к выдаче» starts expires.
  ["ready", "expire_reserve", "reserve_expired"],
  ["reserve_expired", "close_late", "completed"],
  ["created", "admin_close", "completed"],
  ["term_proposed", "admin_close", "completed"],
  ["accepted", "admin_close", "completed"],
  ["ready", "admin_close", "completed"],
  ["response_expired", "admin_close", "completed"],
  ["term_expired", "admin_close", "completed"],
  ["reserve_expired", "admin_close", "completed"],
  ["created", "admin_cancel", "cancelled_by_admin"],
  ["term_proposed", "admin_cancel", "cancelled_by_admin"],
  ["accepted", "admin_cancel", "cancelled_by_admin"],
  ["ready", "admin_cancel", "cancelled_by_admin"],
];

/**
 * Every allowed move of an order on a service (PRODUCT 11, ARCHITECTURE
 * 6.3, TASK-038); anything else is refused.
 */
const serviceAllowed: Allowed = [
  // «Подтвердить время» — the time the user asked for.
  ["created", "accept", "accepted"],
  ["created", "propose_time", "term_proposed"],
  ["term_proposed", "agree_term", "accepted"],
  ["term_proposed", "reject_term", "cancelled_by_user"],
  ["term_proposed", "expire_term", "term_expired"],
  ["created", "expire_no_response", "response_expired"],
  ["created", "decline", "declined_by_supplier"],
  // D-072 carried over, and `decline_after_confirm`.
  ["term_proposed", "decline", "declined_by_supplier"],
  ["accepted", "decline", "declined_by_supplier"],
  ["created", "cancel", "cancelled_by_user"],
  ["term_proposed", "cancel", "cancelled_by_user"],
  ["accepted", "cancel", "cancelled_by_user"],
  ["created", "admin_cancel", "cancelled_by_admin"],
  ["term_proposed", "admin_cancel", "cancelled_by_admin"],
  ["accepted", "admin_cancel", "cancelled_by_admin"],
  ["accepted", "close", "completed"],
  ["accepted", "mark_no_show", "no_show"],
  ["accepted", "expire_visit", "visit_unresolved"],
  ["visit_unresolved", "close_late", "completed"],
  ["created", "admin_close", "completed"],
  ["term_proposed", "admin_close", "completed"],
  ["accepted", "admin_close", "completed"],
  ["response_expired", "admin_close", "completed"],
  ["term_expired", "admin_close", "completed"],
  ["no_show", "admin_close", "completed"],
  ["visit_unresolved", "admin_close", "completed"],
];

const allowedByKind: Record<OrderKind, Allowed> = {
  stock: stockAllowed,
  on_order: onOrderAllowed,
  service: serviceAllowed,
};

describe("orderTransition", () => {
  describe.each(orderKinds)("%s", (kind) => {
    it.each(allowedByKind[kind])("%s --%s--> %s", (from, action, to) => {
      expect(orderTransition(from, action, kind)).toBe(to);
    });

    it("refuses every other pair of a status and an action", () => {
      const key = (from: string, action: string) => `${from}/${action}`;
      const known = new Set(allowedByKind[kind].map(([from, action]) => key(from, action)));
      for (const from of orderStatuses) {
        for (const action of orderActions) {
          if (!known.has(key(from, action))) {
            expect(orderTransition(from, action, kind), key(from, action)).toBeNull();
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
          expect(orderTransition(status, action, kind), `${status}/${action}`).toBeNull();
        }
      }
      // Neither of the two touches an order already given out, cancelled or declined.
      for (const status of [
        "completed",
        "cancelled_by_user",
        "declined_by_supplier",
        "cancelled_by_admin",
      ] as const) {
        expect(orderTransition(status, "close_late", kind)).toBeNull();
        expect(orderTransition(status, "admin_close", kind)).toBeNull();
      }
      // An order that is over is never cancelled by the administrator.
      for (const status of orderStatuses.filter((entry) => !isActiveOrderStatus(entry))) {
        expect(orderTransition(status, "admin_cancel", kind), status).toBeNull();
      }
      // An order the supplier never answered, or whose term the user never
      // agreed to, is never closed late (PRODUCT 10.7).
      expect(orderTransition("response_expired", "close_late", kind)).toBeNull();
      expect(orderTransition("term_expired", "close_late", kind)).toBeNull();
    });

    it("gives no way to «completed» but the code, the late code and the administrator", () => {
      const toCompleted = orderActions.filter((action) =>
        orderStatuses.some((from) => orderTransition(from, action, kind) === "completed"),
      );
      expect([...toCompleted]).toEqual(["close", "close_late", "admin_close"]);
      expect(orderTransition("created", "close", kind)).toBeNull();
    });

    it("lets the administrator cancel exactly what the user may cancel", () => {
      expect(orderActionSources("admin_cancel", kind)).toEqual(orderActionSources("cancel", kind));
    });
  });

  it("knows no talk of a term for an item in stock", () => {
    for (const action of ["propose_term", "agree_term", "reject_term", "expire_term"] as const) {
      expect(orderActionSources(action, "stock"), action).toEqual([]);
      for (const from of orderStatuses) {
        expect(orderTransition(from, action, "stock"), `${from}/${action}`).toBeNull();
      }
    }
    expect(orderTransition("term_proposed", "cancel", "stock")).toBeNull();
  });

  it("gives an order under order a reserve only once it is ready", () => {
    expect(orderTransition("accepted", "expire_reserve", "on_order")).toBeNull();
    expect(orderTransition("ready", "expire_reserve", "on_order")).toBe("reserve_expired");
    expect(orderTransition("accepted", "expire_reserve", "stock")).toBe("reserve_expired");
  });

  it("takes an order under order on only by the supplier's confirmation or the user's «yes»", () => {
    const toAccepted = orderActions.filter((action) =>
      orderStatuses.some((from) => orderTransition(from, action, "on_order") === "accepted"),
    );
    expect([...toAccepted]).toEqual(["accept", "agree_term"]);
    // The supplier can't skip the user's answer, nor propose again.
    expect(orderTransition("term_proposed", "accept", "on_order")).toBeNull();
    expect(orderTransition("term_proposed", "propose_term", "on_order")).toBeNull();
    expect(orderTransition("term_proposed", "mark_ready", "on_order")).toBeNull();
    expect(orderTransition("term_proposed", "close", "on_order")).toBeNull();
  });

  it("lets the supplier decline while the user thinks the term over (D-072)", () => {
    expect(orderTransition("term_proposed", "decline", "on_order")).toBe("declined_by_supplier");
    // A WhatsApp button never reaches it: W-01a means «this new order» (`onlyFrom`).
    expect(orderTransition("term_proposed", "decline", "stock")).toBeNull();
    expect(orderActionSources("decline", "on_order")).toEqual([
      "created",
      "term_proposed",
      "accepted",
      "ready",
    ]);
  });

  it("knows no visit, no-show nor «ready» but for a service, and no other talk of time", () => {
    for (const action of ["propose_time", "mark_no_show", "expire_visit"] as const) {
      expect(orderActionSources(action, "stock"), action).toEqual([]);
      expect(orderActionSources(action, "on_order"), action).toEqual([]);
    }
    // A service is never «ready» and has no reserve; it never proposes a term.
    for (const action of ["mark_ready", "expire_reserve", "propose_term"] as const) {
      expect(orderActionSources(action, "service"), action).toEqual([]);
    }
    for (const status of ["no_show", "visit_unresolved"] as const) {
      expect(orderTransition(status, "close_late", "stock"), status).toBeNull();
      expect(orderTransition(status, "admin_close", "on_order"), status).toBeNull();
    }
  });

  it("confirms a service's time only by the supplier or the user's «yes»", () => {
    const toAccepted = orderActions.filter((action) =>
      orderStatuses.some((from) => orderTransition(from, action, "service") === "accepted"),
    );
    expect([...toAccepted]).toEqual(["accept", "agree_term"]);
    expect(orderTransition("term_proposed", "accept", "service")).toBeNull();
    expect(orderTransition("term_proposed", "propose_time", "service")).toBeNull();
    expect(orderTransition("term_proposed", "close", "service")).toBeNull();
    // A no-show and an unresolved visit come only from a confirmed time.
    expect(orderActionSources("mark_no_show", "service")).toEqual(["accepted"]);
    expect(orderActionSources("expire_visit", "service")).toEqual(["accepted"]);
    // Only an unresolved visit is closed late — never a no-show (D-043 is the administrator's).
    expect(orderActionSources("close_late", "service")).toEqual(["visit_unresolved"]);
  });

  it("names the actor of each action", () => {
    expect(orderActionActor.propose_time).toBe("supplier");
    expect(orderActionActor.mark_no_show).toBe("supplier");
    expect(orderActionActor.expire_visit).toBe("system");
    expect(orderActionActor.accept).toBe("supplier");
    expect(orderActionActor.cancel).toBe("user");
    expect(orderActionActor.expire_reserve).toBe("system");
    expect(orderActionActor.close_late).toBe("supplier");
    expect(orderActionActor.admin_close).toBe("admin");
    expect(orderActionActor.admin_cancel).toBe("admin");
    expect(orderActionActor.propose_term).toBe("supplier");
    expect(orderActionActor.agree_term).toBe("user");
    expect(orderActionActor.reject_term).toBe("user");
    expect(orderActionActor.expire_term).toBe("system");
    expect(orderActionSources("accept", "stock")).toEqual(["created"]);
    expect(orderActionSources("close_late", "on_order")).toEqual(["reserve_expired"]);
  });

  it("keeps the active statuses those an order still goes through", () => {
    expect([...activeOrderStatuses]).toEqual(["created", "accepted", "ready", "term_proposed"]);
    expect(isActiveOrderStatus("ready")).toBe(true);
    expect(isActiveOrderStatus("term_proposed")).toBe(true);
    expect(isActiveOrderStatus("reserve_expired")).toBe(false);
    expect(isActiveOrderStatus("term_expired")).toBe(false);
    // Every active status has a move out of it for some kind; a final one has
    // none but the two exceptions.
    for (const status of activeOrderStatuses) {
      const out = orderKinds.some((kind) =>
        orderActions.some((action) => orderTransition(status, action, kind) !== null),
      );
      expect(out, status).toBe(true);
    }
  });

  it("marks apart the active orders awaiting a receipt (PRODUCT 6.7)", () => {
    expect([...awaitingReceiptOrderStatuses]).toEqual(["accepted", "ready"]);
    // A subset of the active ones, never a second definition of «active».
    for (const status of awaitingReceiptOrderStatuses) {
      expect(isActiveOrderStatus(status), status).toBe(true);
    }
    expect(orderAwaitsReceipt("created")).toBe(false);
    expect(orderAwaitsReceipt("term_proposed")).toBe(false);
    expect(orderAwaitsReceipt("accepted")).toBe(true);
    expect(orderAwaitsReceipt("completed")).toBe(false);
    for (const status of orderStatuses.filter((entry) => !isActiveOrderStatus(entry))) {
      expect(orderAwaitsReceipt(status), status).toBe(false);
    }
  });

  it("asks the user for an answer only while another term waits for it", () => {
    expect([...answerAwaitingOrderStatuses]).toEqual(["term_proposed"]);
    for (const status of orderStatuses) {
      expect(orderNeedsAnswer(status), status).toBe(status === "term_proposed");
    }
    // The user's answer is exactly the moves out of these statuses that are
    // theirs — another term under order and another time of a service alike.
    for (const status of answerAwaitingOrderStatuses) {
      for (const kind of ["on_order", "service"] as const) {
        const userMoves = orderActions.filter(
          (action) =>
            orderActionActor[action] === "user" && orderTransition(status, action, kind) !== null,
        );
        expect(userMoves, kind).toEqual(["cancel", "agree_term", "reject_term"]);
      }
    }
  });
});
