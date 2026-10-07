import { adminSignalKindSchema, type AdminSignal } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { conflictText, KIND_ORDER, KIND_TITLES, subjectText } from "./signal-words";

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
