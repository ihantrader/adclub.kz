import { ApiError } from "@adclub/api-client";
import type {
  OfferItem,
  PriceImportResult,
  PriceReviewRow,
  PriceReviewSummary,
} from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { createTranslate } from "../translate";
import { formatNumber } from "./price-rules";
import {
  applyBlocked,
  applyNotes,
  applyText,
  changeLines,
  chosenItem,
  decidedText,
  fileText,
  firstTab,
  noteText,
  notAppliedGroups,
  notAppliedText,
  resultLines,
  resultText,
  reviewRefusal,
  summaryText,
  tabLabel,
  uncheckedText,
} from "./review-rules";

const t = createTranslate("ru", null);
const kk = createTranslate("kk", null);
const ZONE = "Asia/Almaty";
const A = "0b6f1c2a-1111-4c2a-9a1b-123456789abc";
const B = "0b6f1c2a-2222-4c2a-9a1b-123456789abc";

function apiError(code: ConstructorParameters<typeof ApiError>[0]["code"], details?: unknown) {
  return new ApiError({ code, message: code, status: 409, retryable: false, details });
}

function summary(overrides: Partial<PriceReviewSummary> = {}): PriceReviewSummary {
  return {
    import: { id: A, status: "review", version: 3 } as PriceReviewSummary["import"],
    groups: { confident: 1100, review: 80, notFound: 48, errors: 12 },
    missing: { offers: 5, withActiveOrders: 2, action: null, decidedBy: null },
    sharpPrice: { rows: 3, unconfirmed: 1 },
    preview: {
      update: 2,
      create: 1,
      withdraw: 0,
      request: 3,
      unchecked: 78,
      priceConfirmationRequired: 1,
    },
    canApply: false,
    ...overrides,
  };
}

const ITEM = { id: A, name: { text: "Колодки", isFallback: false } } as OfferItem;
const OTHER = { id: B, name: { text: "Колодки TRW", isFallback: false } } as OfferItem;

function row(overrides: Partial<PriceReviewRow> = {}): PriceReviewRow {
  return {
    rowNo: 14,
    group: "confident",
    parsed: {
      article: "04465-0K090",
      articleNorm: "044650K090",
      brand: "Geely",
      name: "Колодки передние",
      price: 13_000,
      availability: "in_stock",
      quantity: null,
      leadDays: null,
    },
    errors: [],
    source: "exact_article",
    byName: false,
    item: ITEM,
    candidates: [],
    aiProposed: false,
    aiConfidence: null,
    aiExplanation: null,
    note: null,
    offer: { id: B, status: "active", price: 12_500, availability: "in_stock", leadDays: 0 },
    sharpPrice: false,
    decision: null,
    priceConfirmed: false,
    sendRequest: false,
    requestRejectReason: null,
    outcome: null,
    ...overrides,
  };
}

describe("the summary and the button of S-PRICE-03 (TASK-048)", () => {
  it("says the groups word for word, with the missing offers and their orders", () => {
    expect(summaryText(summary(), t, "ru")).toBe(
      `${formatNumber(1240)} строк: уверенно — ${formatNumber(1100)}; нужно проверить — 80; не найдено — 48; ошибки в строках — 12. Пропали из файла — 5 (по 2 есть активные заявки)`,
    );
    expect(
      summaryText(
        summary({ missing: { offers: 0, withActiveOrders: 0, action: null, decidedBy: null } }),
        t,
        "ru",
      ),
    ).toMatch(/Пропали из файла — 0$/);
  });

  it("names the button by the server's preview: new and changed offers are «обновить»", () => {
    expect(applyText(summary(), t)).toBe(
      "Применить: обновить 3 · снять 0 · отправить на добавление 3",
    );
  });

  it("keeps the button off until the missing offers have a choice, and without a network", () => {
    expect(applyBlocked(summary(), true)).toBe("missing_choice");
    const chosen = summary({
      missing: { offers: 5, withActiveOrders: 2, action: "keep", decidedBy: null },
    });
    expect(applyBlocked(chosen, true)).toBeNull();
    expect(applyBlocked(chosen, false)).toBe("offline");
    expect(
      applyBlocked(
        summary({ missing: { offers: 0, withActiveOrders: 0, action: null, decidedBy: null } }),
        true,
      ),
    ).toBeNull();
    expect(
      applyBlocked({ ...chosen, import: { ...chosen.import, status: "applying" } }, true),
    ).toBe("not_review");
  });

  it("tells the rows left out beside the button", () => {
    expect(applyNotes(summary(), t, "ru")).toEqual([
      "78 строк не проверены и не будут применены",
      "Ждут подтверждения новой цены: 1 строка",
    ]);
    expect(
      applyNotes(
        summary({
          preview: {
            update: 0,
            create: 0,
            withdraw: 0,
            request: 0,
            unchecked: 0,
            priceConfirmationRequired: 0,
          },
        }),
        t,
        "ru",
      ),
    ).toEqual([]);
  });

  it("agrees the verb with the number of rows left unchecked", () => {
    expect(uncheckedText(821, t, "ru")).toBe("821 строка не проверена и не будет применена");
    expect(uncheckedText(800, t, "ru")).toBe("800 строк не проверены и не будут применены");
  });

  it("opens on what wants a decision first, with the counters on the tabs", () => {
    expect(firstTab(summary())).toBe("review");
    const checked = summary({
      preview: { ...summary().preview, unchecked: 0 },
    });
    expect(firstTab(checked)).toBe("missing");
    expect(tabLabel(summary(), "confident", t)).toBe(`Уверенно · ${formatNumber(1100)}`);
    expect(tabLabel(summary(), "missing", kk)).toBe("Файлдан жоғалғандар · 5");
  });
});

describe("a row of the review", () => {
  it("shows the file as written and «было → стало»", () => {
    expect(fileText(row())).toBe("04465-0K090 · Geely · Колодки передние");
    expect(changeLines(row(), t)).toEqual([`${formatNumber(12_500)} → ${formatNumber(13_000)} ₸`]);
    expect(
      changeLines(
        row({
          parsed: { ...row().parsed!, availability: "on_order", leadDays: 3 },
        }),
        t,
      ),
    ).toEqual([
      `${formatNumber(12_500)} → ${formatNumber(13_000)} ₸`,
      "в наличии → под заказ",
      "срок 0 → 3 дн.",
    ]);
    expect(changeLines(row({ offer: null }), t)).toEqual([
      `${formatNumber(13_000)} ₸ · новое предложение`,
      "в наличии",
    ]);
  });

  it("takes the decided item, and none for a skipped row", () => {
    expect(chosenItem(row())).toBe(ITEM);
    expect(
      chosenItem(
        row({
          candidates: [OTHER],
          decision: {
            kind: "accept",
            itemId: B,
            by: { memberId: A, name: "Ерлан" },
            at: "2026-10-13T09:02:00.000Z",
          },
        }),
      ),
    ).toBe(OTHER);
    expect(
      chosenItem(
        row({
          decision: {
            kind: "skip",
            itemId: null,
            by: { memberId: A, name: "Ерлан" },
            at: "2026-10-13T09:02:00.000Z",
          },
        }),
      ),
    ).toBeNull();
  });

  it("says who decided and when", () => {
    const decided = row({
      decision: {
        kind: "other",
        itemId: A,
        by: { memberId: A, name: "Марат" },
        at: new Date().toISOString(),
      },
    });
    expect(decidedText(decided, ZONE, "ru", t)).toMatch(/^Другая позиция · Марат, в \d\d:\d\d$/);
    expect(decidedText(row(), ZONE, "ru", t)).toBeNull();
  });

  it("explains a note of matching in words", () => {
    expect(noteText(row({ note: { code: "same_item", rowNo: 31 } }), t)).toBe(
      "На эту же позицию указывает строка 31",
    );
    expect(noteText(row(), t)).toBeNull();
  });
});

describe("a refusal of the server", () => {
  it("names the colleague who changed the review and lets the decision be repeated", () => {
    const refusal = reviewRefusal(
      apiError("PRICE_IMPORT_VERSION_CONFLICT", {
        status: "review",
        version: 4,
        confirmedBy: null,
        confirmedAt: null,
        changedBy: { memberId: A, name: "Марат" },
        changedAt: "2026-10-13T09:02:00.000Z",
      }),
      ZONE,
      "ru",
      t,
    );
    expect(refusal).toEqual({
      text: "Сверку только что изменил Марат — данные обновлены",
      reload: true,
      repeatable: true,
      left: false,
    });
  });

  it("names who applied the price list first", () => {
    const refusal = reviewRefusal(
      apiError("PRICE_IMPORT_STATE", {
        status: "applied",
        appliedBy: { memberId: A, name: "Ерлан" },
        appliedAt: new Date().toISOString(),
      }),
      ZONE,
      "ru",
      t,
    );
    expect(refusal.text).toMatch(/^Прайс уже применил Ерлан в \d\d:\d\d$/);
    expect(refusal).toMatchObject({ left: true, repeatable: false });
    expect(
      reviewRefusal(
        apiError("PRICE_IMPORT_STATE", { status: "expired", appliedBy: null, appliedAt: null }),
        ZONE,
        "ru",
        t,
      ).text,
    ).toBe("Сверка истекла — загрузите прайс заново");
  });

  it("says why an item can't take the row", () => {
    expect(
      reviewRefusal(
        apiError("PRICE_IMPORT_ITEM_UNAVAILABLE", { reason: "service_item" }),
        ZONE,
        "ru",
        t,
      ).text,
    ).toBe("Это услуга — цены услуг задаются по моделям, не из прайса");
    expect(reviewRefusal(apiError("SUPPLIER_BLOCKED"), ZONE, "ru", t).text).toBe(
      "Кабинет заблокирован администратором клуба — прайс применить нельзя",
    );
  });
});

describe("the result (S-PRICE-04)", () => {
  const result: PriceImportResult = {
    updated: 120,
    created: 4,
    unchanged: 900,
    returned: 2,
    withdrawnOutOfStock: 3,
    withdrawnMissing: 1,
    requested: 7,
    notApplied: [
      { reason: "price_confirmation_required", rows: 2 },
      { reason: "out_of_stock", rows: 5 },
      { reason: "duplicate_item", rows: 0 },
    ],
    skipped: 60,
  };

  it("says the result word for word", () => {
    expect(resultText(result, t)).toBe(
      "Готово: обновлено 122, снято 4, на добавление отправлено 7 — результат в разделе «Модерация»",
    );
    expect(resultLines(result, t)).toEqual([
      "Создано новых предложений: 4",
      "Вернулось в продажу: 2",
      "Снято — «нет в наличии» в файле: 3",
      "Снято — нет в файле: 1",
      "Без изменений: 900",
      "Пропущено и не проверено: 60",
    ]);
  });

  it("groups «Не применено» by reason in words, the most rows first", () => {
    expect(notAppliedGroups(result)).toEqual([
      { reason: "out_of_stock", rows: 5 },
      { reason: "price_confirmation_required", rows: 2 },
    ]);
    expect(notAppliedText("price_confirmation_required", t)).toMatch(/^Требует подтверждения цены/);
    expect(notAppliedText("item_unavailable", t)).toMatch(/^Позиция недоступна/);
  });
});
