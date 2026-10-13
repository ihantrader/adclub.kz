import { describe, expect, it } from "vitest";
import { reviewRuleFindings, type ReviewRuleContext } from "./review-rules";

const AUTOMARKET: ReviewRuleContext = {
  supplierNames: ["Автомаркет"],
  employeeNames: ["Айгерим Касымова", "Ерлан", "Ли"],
};

const kinds = (text: string, context: ReviewRuleContext = AUTOMARKET) =>
  reviewRuleFindings(text, context).map((finding) => finding.kind);

describe("the rules of the review check (TASK-049)", () => {
  it.each([
    "долго ждал ответа, цена в итоге выше",
    "Всё отлично, колодки подошли, спасибо",
    "Цена выше обещанной, больше не приду",
    "Ужасный сервис, ждал три дня",
    "Авто приехало вовремя, маркетинг ни при чём",
    "Кепілдік бар, бәрі жақсы",
    "Great service, fast pickup",
    "1 000 000 км пробега, масло хорошее",
    "Ли",
  ])("lets «%s» through", (text) => {
    expect(kinds(text)).toEqual([]);
  });

  it.each([
    ["Автомаркет топ, звоните +7 705 555 01 01", ["contacts", "supplier_name"]],
    ["отличный магазин Автомаркет, рекомендую", ["supplier_name"]],
    ["был в автомаркете, всё хорошо", ["supplier_name"]],
    ["АВТОМАРКЕТ лучший", ["supplier_name"]],
    ["avtomarket top", ["supplier_name"]],
    ["Авто маркет супер", ["supplier_name"]],
    ["пишите на shop@example.kz", ["contacts"]],
    ["смотрите www.automarket.kz", ["contacts"]],
    ["инстаграм @automarket_kz", ["contacts"]],
    ["менеджер Айгерим помогла", ["employee_name"]],
    ["спасибо Ерлану", ["employee_name"]],
    ["Касымова всё объяснила", ["employee_name"]],
    ["Aigerim pomogla", ["employee_name"]],
  ])("holds «%s»", (text, expected) => {
    expect(kinds(text)).toEqual(expected);
  });

  it("reads the legal form and a multiword name", () => {
    const context: ReviewRuleContext = {
      supplierNames: ["ТОО «Шины Юг»"],
      employeeNames: [],
    };
    expect(kinds("Шины Юг молодцы", context)).toEqual(["supplier_name"]);
    expect(kinds("шины юга лучшие", context)).toEqual(["supplier_name"]);
    expect(kinds("поменял шины на юге", context)).toEqual([]);
    expect(kinds("ТОО хорошее", context)).toEqual([]);
  });

  it("names the contacts found", () => {
    expect(reviewRuleFindings("звоните 8 705 555 01 01 или shop@example.kz", AUTOMARKET)).toEqual([
      { kind: "contacts", contacts: ["phone", "email"] },
    ]);
  });
});
