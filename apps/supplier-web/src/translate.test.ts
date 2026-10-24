import type { SupplierTextKey } from "@adclub/i18n";
import { describe, expect, it, vi } from "vitest";
import { createTranslate, keepTogether } from "./translate";

describe("a number keeps its word (TASK-079, C19)", () => {
  const nb = String.fromCharCode(0xa0);

  it("joins a number to its word, to «₸» and its groups with a no-break space", () => {
    expect(keepTogether("до 13 октября")).toBe(`до 13${nb}октября`);
    expect(keepTogether("12 500 ₸")).toBe(`12${nb}500${nb}₸`);
    expect(keepTogether("через 15 мин")).toBe(`через 15${nb}мин`);
  });

  it("leaves other spaces alone: between words, before a dash, inside a time", () => {
    expect(keepTogether("Срок поставки прошёл — 14:02")).toBe("Срок поставки прошёл — 14:02");
    expect(keepTogether("2 — 3")).toBe("2 — 3");
  });

  it("is what every text of the cabinet goes through", () => {
    const t = createTranslate("ru", null);
    expect(t("orders.bringBy", { date: "17 октября" })).toBe(`Привезти до 17${nb}октября`);
  });
});

describe("a text key the dictionary does not know (TASK-032.A)", () => {
  const missing = "offers.reason.brandNew" as SupplierTextKey;

  it("does not take the cabinet down: the key is shown, with or without values", () => {
    const t = createTranslate("kk", null);
    expect(t(missing)).toBe("offers.reason.brandNew");
    expect(() => t(missing, { n: 2 })).not.toThrow();
    expect(t("offers.title")).not.toBe("offers.title");
  });

  it("is reported in development, once per key; known keys say nothing", () => {
    const warn = vi.fn();
    const t = createTranslate("ru", warn);
    t(missing);
    t(missing, { n: 1 });
    t("offers.title");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("offers.reason.brandNew");
  });
});
