import type { TranslationQueueItem } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  objectLink,
  reasonText,
  rowActions,
  translationFiltersOf,
  translationKindText,
  translationsCount,
  translationsLink,
} from "./translation-words";

const ID = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";

function row(patch: Partial<TranslationQueueItem> = {}): TranslationQueueItem {
  return {
    entityType: "catalog_item",
    entityId: ID,
    field: "name",
    lang: "kk",
    state: "failed",
    sourceText: "Колодки тормозные",
    currentText: null,
    currentOrigin: null,
    isSourceChanged: false,
    failure: "wrong_language",
    entityName: "Колодки тормозные",
    parentId: null,
    updatedAt: "2026-11-20T10:00:00.000Z",
    attempts: 0,
    lastError: null,
    ...patch,
  };
}

describe("«Справочник → Переводы» (TASK-054)", () => {
  it("opens on «Отказано» and keeps the filters in the address under the server's names", () => {
    expect(translationFiltersOf(new URLSearchParams())).toEqual({
      state: "failed",
      entityType: undefined,
      lang: undefined,
    });
    expect(
      translationFiltersOf(new URLSearchParams("state=outdated&entityType=attribute&lang=en")),
    ).toEqual({ state: "outdated", entityType: "attribute", lang: "en" });
    // Something the page does not know is not passed on to the server.
    expect(translationFiltersOf(new URLSearchParams("state=x&entityType=brand&lang=ru"))).toEqual({
      state: "failed",
      entityType: undefined,
      lang: undefined,
    });
    expect(translationsLink()).toBe("/catalog/translations");
    expect(translationsLink({ state: "queued", lang: "kk" })).toBe(
      "/catalog/translations?state=queued&lang=kk",
    );
  });

  it("says why a row is there in words", () => {
    expect(reasonText(row())).toBe("не на том языке");
    expect(reasonText(row({ failure: "too_long" }))).toBe("длиннее допустимого");
    expect(reasonText(row({ failure: "name_taken" }))).toBe("такое название уже у соседа");
    expect(reasonText(row({ state: "queued", failure: null, lastError: null }))).toBeNull();
    expect(
      reasonText(row({ state: "queued", failure: null, lastError: "rejected", attempts: 2 })),
    ).toBe("провайдер отказал · неудачных попыток: 2");
    // A reason the page does not know yet is shown as the server says it.
    expect(reasonText(row({ state: "queued", failure: null, lastError: "new_kind" }))).toBe(
      "new_kind",
    );
    expect(reasonText(row({ state: "outdated", failure: null }))).toBe(
      "русский текст изменился после перевода",
    );
    expect(reasonText(row({ state: "missing", failure: null }))).toBeNull();
    expect(translationKindText(row({ entityType: "attribute", field: "unit" }))).toBe(
      "Характеристика · единица",
    );
  });

  it("leads each row to its object", () => {
    expect(objectLink(row())).toBe(`/catalog/items/${ID}?tab=translations`);
    expect(objectLink(row({ entityType: "category" }))).toBe(`/catalog?node=${ID}`);
    expect(objectLink(row({ entityType: "attribute" }))).toBe(`/catalog?attribute=${ID}`);
    expect(objectLink(row({ entityType: "attribute_option" }))).toBe(`/catalog?option=${ID}`);
    expect(objectLink(row({ entityType: "maintenance_plan_item", parentId: PLAN }))).toBe(
      `/catalog/maintenance/${PLAN}`,
    );
    expect(objectLink(row({ entityType: "maintenance_plan_item" }))).toBeNull();
  });

  it("offers the actions the server allows", () => {
    expect(rowActions(row())).toEqual({
      edit: true,
      retranslate: true,
      keep: false,
      release: false,
    });
    // A waiting one is on its way already.
    expect(rowActions(row({ state: "queued" })).retranslate).toBe(false);
    // An outdated text written by hand: kept as it is, or released; never retranslated.
    expect(
      rowActions(
        row({ state: "outdated", currentOrigin: "manual", currentText: "Тежегіш", failure: null }),
      ),
    ).toEqual({ edit: true, retranslate: false, keep: true, release: true });
  });

  it("counts translations in Russian", () => {
    expect(translationsCount(1)).toBe("1 перевод");
    expect(translationsCount(3)).toBe("3 перевода");
    expect(translationsCount(11)).toBe("11 переводов");
    expect(translationsCount(22)).toBe("22 перевода");
    expect(translationsCount(25)).toBe("25 переводов");
  });
});
