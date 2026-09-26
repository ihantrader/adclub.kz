import { describe, expect, it } from "vitest";
import {
  ACCESS_CLOSED_TEXT,
  fulfillmentText,
  itemText,
  momentText,
  moneyText,
  oneLine,
  orderStateText,
  phoneText,
} from "./order-notice-texts";

const item = (
  names: { kk?: string | null; ru?: string | null },
  article: string | null = null,
) => ({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  type: "part" as const,
  names: { kk: names.kk ?? null, ru: names.ru ?? null, en: null },
  article,
  brand: "Geely",
});

describe("the values of the notices of orders (TASK-025, SCREENS 8.5)", () => {
  it("names the item in the recipient's language, falls back to Russian, adds the article once", () => {
    const pads = item(
      { ru: "Колодки тормозные передние", kk: "Алдыңғы тежегіш қалыптары" },
      "04465-0K090",
    );
    expect(itemText(pads, "ru")).toBe("Колодки тормозные передние 04465-0K090");
    expect(itemText(pads, "kk")).toBe("Алдыңғы тежегіш қалыптары 04465-0K090");
    expect(itemText(item({ ru: "Масло 5W-30" }), "kk")).toBe("Масло 5W-30");
    expect(itemText(item({ ru: "Колодки 04465-0K090" }, "04465-0K090"), "ru")).toBe(
      "Колодки 04465-0K090",
    );
  });

  it("keeps every value on one line — WhatsApp refuses a parameter with a break or a run of spaces", () => {
    expect(oneLine("Колодки\nтормозные\t\t    передние")).toBe("Колодки тормозные передние");
    const long = itemText(item({ ru: "Очень ".repeat(60) }), "ru");
    expect([...long].length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("writes sums with a space between the thousands", () => {
    expect(moneyText(900)).toBe("900");
    expect(moneyText(24_500)).toBe("24 500");
    expect(moneyText(1_234_567)).toBe("1 234 567");
  });

  it("names the way of receiving in both languages", () => {
    expect(fulfillmentText("pickup", "ru")).toBe("самовывоз");
    expect(fulfillmentText("delivery", "kk")).toBe("жеткізу");
  });

  it("writes a deadline in the point's time zone, with the date when it is not today there", () => {
    const now = new Date("2026-09-26T10:00:00Z"); // 15:00 in Almaty
    expect(momentText(new Date("2026-09-26T13:30:00Z"), "Asia/Almaty", now)).toBe("18:30");
    expect(momentText(new Date("2026-09-26T19:10:00Z"), "Asia/Almaty", now)).toBe("27.09 00:10");
  });

  it("writes a Kazakhstan number as people do", () => {
    expect(phoneText("+77011234567")).toBe("+7 701 123 45 67");
    expect(phoneText("+491701234567")).toBe("+491701234567");
  });

  it("says what the order is now: who accepted or declined it and when, cancelled, expired", () => {
    const now = new Date("2026-09-26T10:00:00Z");
    const at = new Date("2026-09-26T07:40:00Z"); // 12:40 in Almaty
    const facts = { handledBy: "Марат", handledAt: at, timeZone: "Asia/Almaty" };
    expect(orderStateText({ ...facts, status: "accepted" }, "ru", now)).toBe(
      "принята: Марат, 12:40",
    );
    expect(orderStateText({ ...facts, status: "ready" }, "kk", now)).toBe(
      "қабылданған: Марат, 12:40",
    );
    expect(orderStateText({ ...facts, status: "declined_by_supplier" }, "ru", now)).toBe(
      "отклонена: Марат, 12:40",
    );
    expect(orderStateText({ ...facts, status: "completed" }, "ru", now)).toBe("выдана");
    expect(
      orderStateText(
        { ...facts, status: "cancelled_by_user", handledBy: null, handledAt: null },
        "ru",
        now,
      ),
    ).toBe("отменена клиентом");
    for (const status of ["response_expired", "reserve_expired"] as const) {
      expect(orderStateText({ ...facts, status }, "ru", now)).toBe("истекла");
      expect(orderStateText({ ...facts, status }, "kk", now)).toBe("мерзімі өткен");
    }
    expect(ACCESS_CLOSED_TEXT.ru).toBe("недоступна: доступ к кабинету закрыт");
  });
});
