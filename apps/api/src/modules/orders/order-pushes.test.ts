import { orderActions } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { pushTemplates, renderPushText } from "../notifications";
import {
  orderPushCurrent,
  orderPushVariables,
  pushDateText,
  pushItemText,
  pushOfMove,
} from "./order-pushes";
import type { OrderRow } from "./schema";

/** The table of TASK-051 requirement 4, move by move. */
describe("pushOfMove", () => {
  const stock = { kind: "stock", fulfillment: "pickup", expiresAt: new Date() } as const;

  it("pushes what SCREENS 8.4 has a text for", () => {
    expect(pushOfMove("accept", stock)?.template).toBe("order_accepted");
    expect(pushOfMove("accept", { ...stock, kind: "on_order" })?.template).toBe("term_confirmed");
    expect(pushOfMove("accept", { ...stock, kind: "service" })?.template).toBe("time_confirmed");
    expect(pushOfMove("mark_ready", stock)?.template).toBe("order_ready");
    expect(
      pushOfMove("mark_ready", { ...stock, fulfillment: "delivery", expiresAt: null })?.template,
    ).toBe("order_ready_delivery");
    expect(pushOfMove("decline", stock)?.kind).toBe("order_declined");
    expect(pushOfMove("propose_term", stock)?.kind).toBe("term_proposed");
    expect(pushOfMove("propose_time", stock)?.kind).toBe("time_proposed");
    for (const action of ["close", "close_late", "admin_close"] as const) {
      expect(pushOfMove(action, stock)?.kind).toBe("order_closed");
    }
    expect(pushOfMove("expire_no_response", stock)?.kind).toBe("order_expired_no_response");
  });

  it("pushes nothing for the user's own moves and for moves SCREENS 8.4 has no text for", () => {
    const silent = orderActions.filter((action) => pushOfMove(action, stock) === null);
    expect(silent.sort()).toEqual(
      [
        "cancel",
        "agree_term",
        "reject_term",
        "admin_cancel",
        "expire_reserve",
        "expire_term",
        "expire_visit",
        "mark_no_show",
      ].sort(),
    );
  });
});

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "1d2c3b4a-5e6f-4a1b-8c9d-0e1f2a3b4c5d",
    kind: "stock",
    fulfillment: "pickup",
    confirmationCode: "482915",
    qrToken: "secret-qr-token",
    expiresAt: new Date("2026-11-05T13:30:00Z"),
    termAnswerBy: new Date("2026-11-05T13:30:00Z"),
    proposedReadyOn: "2026-11-12",
    proposedAt: new Date("2026-11-07T06:00:00Z"),
    visitAt: new Date("2026-11-07T06:00:00Z"),
    receiptOn: "2026-11-12",
    offerSnapshot: {
      supplier: { id: "x", name: "Автомаркет" },
      location: { timeZone: "Asia/Almaty", address: "ул. Райымбека, 200" },
      item: {
        names: { ru: "Колодки тормозные передние", kk: "Алдыңғы тежегіш қалыптары", en: null },
        article: "04465-0K090",
      },
    },
    ...overrides,
  } as unknown as OrderRow;
}

describe("orderPushVariables", () => {
  it("writes each template in each language with the values of the order", () => {
    const ru = renderPushText(
      "order_ready",
      "ru",
      orderPushVariables("order_ready", order(), "ru", "Автомаркет"),
    );
    expect(ru).toBe(
      "Можно забирать: Колодки тормозные передние 04465-0K090. Резерв до 18:30, 5 ноября",
    );
    const kk = renderPushText(
      "order_accepted",
      "kk",
      orderPushVariables("order_accepted", order(), "kk", "Автомаркет"),
    );
    expect(kk).toBe("Автомаркет өтінімді қабылдады: Алдыңғы тежегіш қалыптары 04465-0K090");
    const en = renderPushText(
      "time_confirmed",
      "en",
      orderPushVariables("time_confirmed", order({ kind: "service" }), "en", null),
    );
    // No English name: the Russian one; no club access: «The supplier».
    expect(en).toBe("We expect you on 7 November at 11:00, The supplier");
  });

  it("says «Поставщик» without club access", () => {
    expect(
      renderPushText(
        "order_accepted",
        "ru",
        orderPushVariables("order_accepted", order(), "ru", null),
      ),
    ).toBe("Поставщик принял заявку: Колодки тормозные передние 04465-0K090");
  });

  it("never carries the code, the QR or the address", () => {
    for (const code of Object.keys(pushTemplates)) {
      if (
        code === "review_text_rejected" ||
        code === "payment_failed" ||
        code === "maintenance_reminder" ||
        code === "maintenance_reminder_service" ||
        code === "mileage_request"
      ) {
        continue;
      }
      const values = orderPushVariables(
        code as keyof typeof pushTemplates,
        order(),
        "ru",
        "Автомаркет",
      );
      const text = JSON.stringify(values);
      expect(text).not.toContain("482915");
      expect(text).not.toContain("secret-qr-token");
      expect(text).not.toContain("Райымбека");
    }
  });

  it("names dates in the person's language", () => {
    expect(pushDateText("2026-03-14", "kk")).toBe("14 наурыз");
    expect(pushDateText("2026-03-14", "en")).toBe("14 March");
    expect(
      pushItemText({ names: { ru: null, kk: null, en: null }, article: "X1" } as never, "ru"),
    ).toBe("X1");
  });
});

/** TASK-052: a WhatsApp copy goes only while its push still says something true. */
describe("orderPushCurrent", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  const later = new Date("2026-11-04T11:00:00Z");
  const earlier = new Date("2026-11-04T09:00:00Z");
  const order = (
    status: string,
    extra: { expiresAt?: Date | null; termAnswerBy?: Date | null } = {},
  ) =>
    ({ status, expiresAt: null, termAnswerBy: null, ...extra }) as Parameters<
      typeof orderPushCurrent
    >[0];

  it("keeps «принята» while the order is active, not once it is cancelled", () => {
    expect(orderPushCurrent(order("accepted"), "order_accepted", now)).toBe(true);
    expect(orderPushCurrent(order("ready"), "order_accepted", now)).toBe(true);
    expect(orderPushCurrent(order("cancelled_by_admin"), "order_accepted", now)).toBe(false);
    expect(orderPushCurrent(order("cancelled_by_user"), "order_confirmed", now)).toBe(false);
  });

  it("keeps a final event for good", () => {
    for (const kind of ["order_declined", "order_closed", "order_expired_no_response"] as const) {
      expect(orderPushCurrent(order("completed"), kind, now)).toBe(true);
    }
  });

  it("drops a reserve warning past its time and a proposal past the time to answer", () => {
    expect(orderPushCurrent(order("ready", { expiresAt: later }), "reserve_expiring", now)).toBe(
      true,
    );
    expect(orderPushCurrent(order("ready", { expiresAt: earlier }), "reserve_expiring", now)).toBe(
      false,
    );
    expect(
      orderPushCurrent(order("term_proposed", { termAnswerBy: later }), "term_proposed", now),
    ).toBe(true);
    expect(
      orderPushCurrent(order("term_proposed", { termAnswerBy: earlier }), "time_proposed", now),
    ).toBe(false);
    expect(orderPushCurrent(order("accepted", { termAnswerBy: later }), "term_proposed", now)).toBe(
      false,
    );
  });
});
