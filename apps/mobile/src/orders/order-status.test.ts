import { orderStatusSchema } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { isActiveStatus, listStatusKey, orderStatusView } from "./order-status";

// Plain Node checks of the table of states of M-ORD-03 (TASK-030 requirement 3, AC-4).

describe("the state of an order on its screen", () => {
  it("has a row for every status the server has for an order in stock", () => {
    for (const status of orderStatusSchema.options) {
      for (const fulfillment of ["pickup", "delivery"] as const) {
        const view = orderStatusView({ status, fulfillment });
        expect(view.title, `${status}/${fulfillment}`).toMatch(/^orderStatus\./);
      }
    }
  });

  it("follows the table of SCREENS M-ORD-03 row by row", () => {
    expect(orderStatusView({ status: "created", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.created.title",
      text: "orderStatus.created.text",
      deadline: "respondBy",
      code: "dimmed",
      place: "district",
      group: "waiting",
      cancellable: true,
    });
    expect(orderStatusView({ status: "accepted", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.accepted.title",
      text: "orderStatus.acceptedPickup.text",
      deadline: "reserveUntil",
      code: "shown",
      place: "full",
      group: "inProgress",
    });
    expect(orderStatusView({ status: "accepted", fulfillment: "delivery" })).toMatchObject({
      text: "orderStatus.acceptedDelivery.text",
      deadline: null,
      code: "shown",
      place: "full",
    });
    expect(orderStatusView({ status: "ready", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.readyPickup.title",
      text: "orderStatus.readyPickup.text",
      deadline: "reserveUntil",
      code: "large",
      group: "ready",
    });
    expect(orderStatusView({ status: "ready", fulfillment: "delivery" })).toMatchObject({
      title: "orderStatus.readyDelivery.title",
      text: "orderStatus.readyDelivery.text",
      code: "shown",
      group: "ready",
    });
    expect(orderStatusView({ status: "completed", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.completed.title",
      code: "none",
      place: "full",
      finished: true,
      cancellable: false,
    });
    expect(orderStatusView({ status: "cancelled_by_user", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.cancelled.title",
      text: null,
      place: "none",
    });
    expect(
      orderStatusView({ status: "declined_by_supplier", fulfillment: "pickup" }),
    ).toMatchObject({
      title: "orderStatus.declined.title",
      text: "orderStatus.declined.text",
    });
    expect(orderStatusView({ status: "response_expired", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.responseExpired.title",
    });
    expect(orderStatusView({ status: "reserve_expired", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.reserveExpired.title",
    });
  });

  it("shows a code only while the order is active, and lets it be cancelled only until it is given out", () => {
    for (const status of orderStatusSchema.options) {
      const view = orderStatusView({ status, fulfillment: "pickup" });
      expect(view.code !== "none", status).toBe(isActiveStatus(status));
      expect(view.cancellable, status).toBe(isActiveStatus(status));
      expect(view.finished, status).toBe(!isActiveStatus(status));
    }
  });

  it("never paints an outcome red (DESIGN 7.8)", () => {
    for (const status of orderStatusSchema.options) {
      expect(orderStatusView({ status, fulfillment: "pickup" }).group).not.toBe("needsReply");
    }
    expect(orderStatusView({ status: "declined_by_supplier", fulfillment: "pickup" }).group).toBe(
      "finished",
    );
  });

  it("shows an unknown status of a newer server as finished, without a code", () => {
    const view = orderStatusView({ status: "brand_new" as never, fulfillment: "pickup" });
    expect(view).toMatchObject({ code: "none", finished: true, cancellable: false });
  });

  it("reads a given-out order in a list as «Получено» without its date", () => {
    expect(listStatusKey({ status: "completed", fulfillment: "pickup" })).toBe(
      "orderStatus.completed.short",
    );
    expect(listStatusKey({ status: "created", fulfillment: "pickup" })).toBe(
      "orderStatus.created.title",
    );
  });
});
