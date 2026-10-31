import type { SupplierCharge } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { formatDay, formatMoment } from "../format";
import {
  amountText,
  cardLine,
  chargeOutcomeText,
  CHARGE_KIND_TEXT,
  DECLINE_REASON_TEXT,
  pauseLines,
  SUPPLIER_SUBSCRIPTION_TEXT,
  termText,
} from "./billing-words";

const plain = (text: string) => text.replaceAll(String.fromCharCode(0xa0), " ");

const charge: SupplierCharge = {
  id: "9f4a7b3c-0c1e-4a52-8d5b-2f0e6a1b7c11",
  kind: "scheduled",
  outcome: "succeeded",
  declineReason: null,
  amount: 1000,
  currency: "KZT",
  periodFrom: "2026-10-04T19:00:00.000Z",
  periodTo: "2026-11-04T19:00:00.000Z",
  at: "2026-11-05T05:00:05.000Z",
  resolvedAt: "2026-11-05T05:00:06.000Z",
  retryAt: null,
};

describe("the words of a supplier's subscription in the admin panel (TASK-042)", () => {
  it("says every status the server can send, and every reason of a bank's refusal", () => {
    expect(Object.keys(SUPPLIER_SUBSCRIPTION_TEXT).sort()).toEqual(
      ["active", "cancelled", "expired", "past_due", "suspended"].sort(),
    );
    expect(SUPPLIER_SUBSCRIPTION_TEXT.suspended).toBe("Приостановлена: не оплачена");
    expect(DECLINE_REASON_TEXT.insufficient_funds).toBe("недостаточно средств");
    expect(Object.keys(DECLINE_REASON_TEXT)).toHaveLength(6);
    expect(Object.keys(CHARGE_KIND_TEXT).sort()).toEqual(["first", "manual", "retry", "scheduled"]);
  });

  it("words the outcome of a charge, with the reason of a refusal and the time of a retry", () => {
    expect(chargeOutcomeText(charge)).toBe("Оплачено");
    expect(
      chargeOutcomeText({ ...charge, outcome: "declined", declineReason: "card_expired" }),
    ).toBe("Отказ: срок действия карты истёк");
    expect(plain(chargeOutcomeText({ ...charge, outcome: "in_progress", resolvedAt: null }))).toBe(
      "Идёт списание",
    );
    expect(
      plain(
        chargeOutcomeText({
          ...charge,
          outcome: "in_progress",
          resolvedAt: null,
          retryAt: "2026-11-05T06:00:00.000Z",
        }),
      ),
    ).toBe(
      `Ждём ответ платёжной системы, повтор ${plain(formatMoment("2026-11-05T06:00:00.000Z"))}`,
    );
  });

  it("writes a card as the cabinet does and a sum with the tenge kept to its number", () => {
    expect(cardLine({ mask: "4242", brand: "visa" })).toBe("•••• 4242 · Visa");
    expect(termText({ expMonth: 3, expYear: 2031 })).toBe("03/31");
    expect(plain(amountText(12_500))).toBe("12 500 ₸");
    expect(amountText(1000)).toContain(String.fromCharCode(0xa0));
  });

  it("puts the administrator's pause beside the billing one, each in its own line", () => {
    const since = "2026-10-31T14:08:03.000Z";
    expect(pauseLines({ admin: null, billing: null })).toEqual({ admin: null, billing: null });
    const both = pauseLines({
      admin: { note: "Проверка документов", since },
      billing: { since },
    });
    expect(plain(both.admin ?? "")).toBe(
      `Пауза администратора: Проверка документов, с ${plain(formatDay(since))}`,
    );
    expect(plain(both.billing ?? "")).toBe(`Пауза по оплате: с ${plain(formatDay(since))}`);
    // Without a note the line has no colon.
    expect(plain(pauseLines({ admin: { note: null, since }, billing: null }).admin ?? "")).toBe(
      `Пауза администратора, с ${plain(formatDay(since))}`,
    );
  });
});
