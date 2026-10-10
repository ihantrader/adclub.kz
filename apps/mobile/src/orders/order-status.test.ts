import { orderStatusSchema } from "@adclub/contracts";
import { mobileText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import { isActiveStatus, listStatusKey, orderMarkKey, orderStatusView } from "./order-status";

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
    // TASK-036.B: the club's administrator cancelled it, not the user.
    expect(orderStatusView({ status: "cancelled_by_admin", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.cancelledByAdmin.title",
      text: "orderStatus.cancelledByAdmin.text",
      code: "none",
      finished: true,
      cancellable: false,
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

  it("follows the rows of an order under order (TASK-037)", () => {
    expect(
      orderStatusView({ status: "accepted", fulfillment: "pickup", kind: "on_order" }),
    ).toMatchObject({
      title: "orderStatus.termConfirmed.title",
      text: "orderStatus.termConfirmed.text",
      deadline: null,
      termDate: "confirmed",
      code: "shown",
      place: "full",
      cancellable: true,
    });
    expect(orderStatusView({ status: "term_proposed", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.termProposed.title",
      text: "orderStatus.termProposed.text",
      deadline: "answerBy",
      termDate: "proposed",
      code: "dimmed",
      place: "district",
      finished: false,
      cancellable: true,
    });
    expect(orderStatusView({ status: "term_expired", fulfillment: "pickup" })).toMatchObject({
      title: "orderStatus.termExpired.title",
      text: "orderStatus.termExpired.text",
      code: "none",
      finished: true,
    });
    // «Готово» of an order under order reads like one in stock.
    expect(
      orderStatusView({ status: "ready", fulfillment: "pickup", kind: "on_order" }),
    ).toMatchObject({ title: "orderStatus.readyPickup.title" });
    // The words fill their places in every language.
    for (const lang of ["ru", "kk", "en"] as const) {
      expect(mobileText(lang, "orderStatus.termProposed.text")).toContain("{date}");
      expect(mobileText(lang, "orderStatus.termProposed.text")).toContain("{time}");
      expect(mobileText(lang, "orderStatus.termConfirmed.text")).toContain("{date}");
    }
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

  it("never repeats the heading in the mark over it, in any language (TASK-030.A)", () => {
    for (const lang of ["ru", "kk", "en"] as const) {
      for (const status of orderStatusSchema.options) {
        for (const fulfillment of ["pickup", "delivery"] as const) {
          const view = orderStatusView({ status, fulfillment });
          const mark = mobileText(lang, orderMarkKey({ status, fulfillment }));
          const title = mobileText(lang, view.title);
          expect(title.startsWith(mark), `${lang} ${status}/${fulfillment}`).toBe(false);
        }
      }
    }
    // Ready for pickup: «Готово» over «Можно забирать».
    expect(orderMarkKey({ status: "ready", fulfillment: "pickup" })).toBe(
      "orderStatus.short.ready",
    );
    expect(mobileText("ru", "orderStatus.short.ready")).toBe("Готово");
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
