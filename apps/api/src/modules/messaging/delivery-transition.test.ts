import { describe, expect, it } from "vitest";
import { deliveryTransition, type DeliveryStatus } from "./messaging.service";
import type { MessageStatus } from "./schema";

/**
 * TASK-024 requirement 4: the provider does not guarantee the order of its
 * events and repeats a delivery until it gets a 200, so a status only ever
 * moves forward. Every pair of "where the message is" and "what the provider
 * says" is here, so a case nobody thought of is a failing line and not a
 * surprise on a real number.
 */
const EVENTS: readonly DeliveryStatus[] = ["sent", "delivered", "read", "failed"];

const TABLE: Readonly<
  Record<MessageStatus, Readonly<Record<DeliveryStatus, DeliveryStatus | null>>>
> = {
  // Not settled yet: the provider's id is written a step before the send is
  // settled, so an event can find the message here — it must wait for the settle
  // (the caller defers it), not write a delivery over a send that has no time yet.
  queued: { sent: null, delivered: null, read: null, failed: null },
  sending: { sent: null, delivered: null, read: null, failed: null },
  // The provider took it: only what comes after it changes anything.
  sent: { sent: null, delivered: "delivered", read: "read", failed: "failed" },
  // Delivered: no step back, and a failure cannot undo a delivery.
  delivered: { sent: null, delivered: null, read: "read", failed: null },
  read: { sent: null, delivered: null, read: null, failed: null },
  // Settled for our own reasons: nothing the provider says changes it.
  failed: { sent: null, delivered: null, read: null, failed: null },
  cancelled: { sent: null, delivered: null, read: null, failed: null },
  unknown: { sent: null, delivered: null, read: null, failed: null },
};

describe("what a delivery event does to a message", () => {
  for (const [current, row] of Object.entries(TABLE) as [
    MessageStatus,
    (typeof TABLE)[MessageStatus],
  ][]) {
    for (const event of EVENTS) {
      it(`${current} + ${event} → ${row[event] ?? "no change"}`, () => {
        expect(deliveryTransition(current, event)).toBe(row[event]);
      });
    }
  }

  it("covers every status there is", () => {
    // A new status added to the type without a row here is a compile error
    // above; this keeps the table honest about the runtime side.
    expect(Object.keys(TABLE).sort()).toEqual(
      ["cancelled", "delivered", "failed", "queued", "read", "sending", "sent", "unknown"].sort(),
    );
  });

  it("gives the same result however the events are shuffled, for the events of one message", () => {
    // sent → delivered → read, in every order the provider might send them.
    const orders: DeliveryStatus[][] = [
      ["sent", "delivered", "read"],
      ["sent", "read", "delivered"],
      ["delivered", "sent", "read"],
      ["delivered", "read", "sent"],
      ["read", "sent", "delivered"],
      ["read", "delivered", "sent"],
    ];
    for (const order of orders) {
      let status: MessageStatus = "sent";
      for (const event of order) {
        status = deliveryTransition(status, event) ?? status;
      }
      expect(status, order.join(" → ")).toBe("read");
    }
  });

  it("applying the same delivery twice changes nothing the second time", () => {
    for (const event of EVENTS) {
      const once = deliveryTransition("sent", event);
      if (once === null) {
        continue;
      }
      expect(deliveryTransition(once, event), event).toBeNull();
    }
  });
});
