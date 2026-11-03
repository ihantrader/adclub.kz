import { adminSignalKindSchema, type AdminSignal } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { conflictText, KIND_ORDER, KIND_TITLES, subjectLink, subjectText } from "./signal-words";

const base: AdminSignal = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "frequent_admin_closes",
  subjectType: "supplier",
  subjectId: "00000000-0000-4000-8000-000000000002",
  status: "open",
  payload: {},
  times: 1,
  firstSeenAt: "2026-10-07T08:00:00.000Z",
  lastSeenAt: "2026-10-07T08:00:00.000Z",
  closedAt: null,
  version: 1,
  acknowledgedAt: null,
  acknowledgedBy: null,
  closedBy: null,
  closeComment: null,
};

describe("the words of signals", () => {
  it("names every kind the server raises, in the order of importance", () => {
    for (const kind of adminSignalKindSchema.options) {
      expect(KIND_TITLES[kind]).toBeTruthy();
      expect(KIND_ORDER).toContain(kind);
    }
  });

  it("says what a signal is about from its payload", () => {
    expect(
      subjectText({
        kind: "duplicate_after_late_close",
        payload: { orderNumber: 1001, otherOrderNumber: 1004 },
      }),
    ).toBe("№ 1001 и № 1004");
    expect(
      subjectText({
        kind: "frequent_admin_closes",
        payload: { supplierName: "Автомаркет", closes: 3, days: 30 },
      }),
    ).toBe("Автомаркет · 3 закрытия за 30 дней");
    expect(
      subjectText({
        kind: "supplier_unreachable",
        payload: { supplierName: "Шины Юг", recipients: 2, recipientsWithoutWhatsapp: 2 },
      }),
    ).toBe("Шины Юг · без WhatsApp 2 из 2 получателей");
    expect(
      subjectText({ kind: "whatsapp_outage", payload: { affectedOrders: 1, failedMessages: 5 } }),
    ).toBe("1 заявка, не дошло 5 уведомлений");
  });

  it("opens a supplier's card on «Сотрудники», nothing else yet (TASK-036)", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    expect(subjectLink({ subjectType: "supplier", subjectId: id })).toBe(
      `/suppliers/${id}?tab=members`,
    );
    // TASK-036.B: an order opens its card, frequent closes — the supplier's orders,
    // the outage — the orders to extend from when it began.
    expect(subjectLink({ subjectType: "order", subjectId: id })).toBe(`/orders/${id}`);
    expect(
      subjectLink({ subjectType: "supplier", subjectId: id, kind: "frequent_admin_closes" }),
    ).toBe(`/suppliers/${id}?tab=orders`);
    expect(
      subjectLink({
        subjectType: "channel",
        subjectId: id,
        kind: "whatsapp_outage",
        payload: { since: "2026-10-07T08:00:00.000Z" },
      }),
    ).toBe("/orders/extensions?from=2026-10-07T08%3A00%3A00.000Z");
    // TASK-039: «Срок поставки прошёл» opens the order.
    expect(KIND_TITLES.supply_overdue).toBe("Срок поставки прошёл");
    expect(subjectLink({ subjectType: "order", subjectId: id, kind: "supply_overdue" })).toBe(
      `/orders/${id}`,
    );
    // TASK-050: «Низкий рейтинг» opens «Рейтинг и отзывы» of the supplier.
    expect(KIND_TITLES.low_rating).toBe("Низкий рейтинг");
    expect(subjectLink({ subjectType: "supplier", subjectId: id, kind: "low_rating" })).toBe(
      `/suppliers/${id}?tab=rating`,
    );
    expect(
      subjectText({
        kind: "low_rating",
        payload: { supplierName: "Автомаркет", rating: 3.4, ratingCount: 5, ratingThreshold: 3.5 },
      }),
    ).toBe("Автомаркет · ★ 3,4 (5) · порог 3,5");
  });

  it("words the three signals of the supplier's card subscription (TASK-042)", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    const plain = (text: string) => text.replaceAll(String.fromCharCode(0xa0), " ");
    expect(KIND_TITLES.payment_failed).toBe("Платёж поставщика не прошёл");
    expect(KIND_TITLES.payment_system_down).toBe("Платёжная система недоступна");
    expect(KIND_TITLES.billing_plan_missing).toBe("Нет тарифа для подписки поставщиков");
    // The failed payment opens the supplier's «Подписка»; the payment system's silence —
    // the charges waiting for it, no tariff — «Тарифы» (TASK-043).
    expect(subjectLink({ subjectType: "supplier", subjectId: id, kind: "payment_failed" })).toBe(
      `/suppliers/${id}?tab=billing`,
    );
    expect(
      subjectLink({ subjectType: "channel", subjectId: id, kind: "payment_system_down" }),
    ).toBe("/billing/payments?groups=awaiting_provider");
    expect(
      subjectLink({ subjectType: "channel", subjectId: id, kind: "billing_plan_missing" }),
    ).toBe("/billing/plans");
    expect(
      plain(
        subjectText({
          kind: "payment_failed",
          payload: {
            supplierName: "Автомаркет",
            declineReason: "insufficient_funds",
            declines: 2,
            amount: 1000,
          },
        }),
      ),
    ).toBe("Автомаркет · недостаточно средств · 2 отказа банка · 1 000 ₸");
    expect(
      subjectText({
        kind: "payment_system_down",
        payload: { failedPayments: 3, windowMinutes: 60 },
      }),
    ).toBe("не принято 3 списания · порог 60 минут");
    // A reason the dictionary doesn't know is shown as the server sent it.
    expect(
      subjectText({
        kind: "payment_failed",
        payload: { supplierName: "Шины Юг", declineReason: "something_new" },
      }),
    ).toBe("Шины Юг · something_new");
  });

  it("tells who closed it first", () => {
    expect(
      conflictText({
        ...base,
        status: "closed",
        closedBy: { kind: "admin", adminId: base.id, name: "Айгерим", phoneMasked: "+7***4567" },
      }),
    ).toBe("Сигнал уже закрыт: Айгерим. Обновите страницу");
    expect(
      conflictText({
        ...base,
        status: "closed",
        closedBy: { kind: "system", adminId: null, name: null, phoneMasked: null },
      }),
    ).toBe("Сигнал уже закрыт: система (событие закончилось). Обновите страницу");
    expect(
      conflictText({
        ...base,
        status: "acknowledged",
        acknowledgedBy: { kind: "admin", adminId: base.id, name: null, phoneMasked: "+7***0001" },
      }),
    ).toBe("Сигнал уже взят в работу: +7***0001");
  });
});
