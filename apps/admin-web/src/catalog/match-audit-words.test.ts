import type { PriceMatchAuditCard } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  auditRowTitle,
  confidenceText,
  percentText,
  wrongConsequences,
  wrongResultText,
} from "./match-audit-words";

function cardWith(offer: PriceMatchAuditCard["offer"]): PriceMatchAuditCard {
  return {
    audit: {
      aiItem: { name: { text: "Колодки Testa Alfa" } },
    } as unknown as PriceMatchAuditCard["audit"],
    offer,
    candidates: [],
  };
}

const offer = {
  id: "00000000-0000-4000-8000-000000000001",
  status: "active" as const,
  price: 5000,
  activeOrders: 0,
  editedByHand: false,
  willWithdraw: true,
  keepReason: null,
};

describe("the words of «Аудит сопоставлений»", () => {
  it("says what «Неверно» will do to the offer before it is done", () => {
    expect(wrongConsequences(cardWith(offer))).toContain(
      "Предложение «Колодки Testa Alfa» будет снято с продажи.",
    );
    expect(
      wrongConsequences(
        cardWith({ ...offer, activeOrders: 2, willWithdraw: false, keepReason: "active_orders" }),
      ),
    ).toContain("Активные заявки: 2 — предложение «Колодки Testa Alfa» останется.");
    expect(
      wrongConsequences(
        cardWith({ ...offer, editedByHand: true, willWithdraw: false, keepReason: "edited" }),
      ).join(" "),
    ).toContain("правили вручную");
    // Always: the memory and «Модерация»; no offer — nothing about it.
    const none = wrongConsequences(cardWith(null));
    expect(none).toHaveLength(2);
    expect(none[0]).toContain("Нужно проверить");
  });

  it("says what «Неверно» did", () => {
    expect(
      wrongResultText({
        memoryRemoved: true,
        offerId: offer.id,
        offerWithdrawn: true,
        keepReason: null,
        activeOrders: 0,
      }),
    ).toBe("Память поставщика удалена, предложение снято с продажи.");
    expect(
      wrongResultText({
        memoryRemoved: false,
        offerId: offer.id,
        offerWithdrawn: false,
        keepReason: "active_orders",
        activeOrders: 1,
      }),
    ).toBe("Памяти для строки не было, предложение осталось: активные заявки — 1.");
  });

  it("writes numbers the Russian way", () => {
    expect(confidenceText(0.9)).toBe("0,90");
    expect(percentText(0.917)).toBe("91,7 %");
    expect(percentText(null)).toBe("—");
    expect(
      auditRowTitle({ article: null, brand: "Geely", name: "Колодки", price: 1, photoText: null }),
    ).toBe("Geely · Колодки");
  });
});
