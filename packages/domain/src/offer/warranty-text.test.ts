import { describe, expect, it } from "vitest";
import { warrantyTextContacts } from "./warranty-text";

describe("contacts in a warranty text (TASK-020.A)", () => {
  it.each([
    "12 месяцев по чеку",
    "Гарантия производителя 24 мес. или 100 000 км",
    "до 1 000 000 км пробега",
    "Гарантия до 31.12.2027",
    "Действует 2024-2026, обмен по чеку",
    "6 мес. Возврат в течение 14 дней",
    "OEM, оригинальная упаковка",
    "Кепілдік 12 ай, чек бойынша",
    "12 months, receipt required",
    "Гарантия 1 год. При установке в сертифицированном сервисе — 2 года",
    "Автомаркет даёт 12 месяцев",
  ])("lets «%s» through", (text) => {
    expect(warrantyTextContacts(text)).toEqual([]);
  });

  it.each([
    ["Автомаркет, +7 705 555 01 01", ["phone"]],
    ["звоните 8 (705) 555-01-01", ["phone"]],
    ["87055550101", ["phone"]],
    ["+7(705)5550101", ["phone"]],
    ["тел. 272-12-34", ["phone"]],
    ["7 705 555 0101 — Айгерим", ["phone"]],
    ["８７０５５５５０１０１", ["phone"]],
    ["8 705 555 01 01", ["phone"]],
    ["8–705–555–01–01", ["phone"]],
    ["подробнее на automarket.kz", ["link"]],
    ["https://example.com/warranty", ["link"]],
    ["www.automarket", ["link"]],
    ["пишите в t.me/automarket", ["link"]],
    ["наш сайт автомаркет.рф", ["link"]],
    ["инстаграм @automarket_kz", ["link"]],
    ["почта info@automarket.kz", ["email"]],
    ["sale@automarket.kz или +77055550101", ["phone", "email"]],
    ["automarket.kz, info@automarket.kz, 8 705 555 01 01", ["phone", "link", "email"]],
  ])("finds contacts in «%s»", (text, kinds) => {
    expect(warrantyTextContacts(text)).toEqual(kinds);
  });
});
