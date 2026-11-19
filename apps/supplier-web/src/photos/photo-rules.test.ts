import { ApiError } from "@adclub/api-client";
import { PHOTO_REJECTED_ITEM_FULL } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { createTranslate } from "../translate";
import { photoRefusal, photoStatusText } from "./photo-rules";

const notNeeded = (details?: unknown) =>
  new ApiError({
    code: "CATALOG_PHOTO_NOT_NEEDED",
    message: "m",
    status: 409,
    retryable: false,
    details,
  });

describe("photo words (TASK-068.A)", () => {
  it("says the refusal of a photo by its reason", () => {
    const t = createTranslate("ru", null);
    expect(photoRefusal(notNeeded({ reason: "request_decided" }), t)).toBe(
      "Запрос уже рассмотрен — фото к нему больше не добавить",
    );
    expect(photoRefusal(notNeeded({ reason: "already_there" }), t)).toBe(
      "Такое фото у позиции уже есть",
    );
    expect(photoRefusal(notNeeded({ reason: "item_has_photo" }), t)).toBe(
      "Фото больше не нужно: у позиции уже есть фото",
    );
    expect(photoRefusal(notNeeded(), t)).toBe("Фото больше не нужно: у позиции уже есть фото");
  });

  it("says the code of a photo that didn't fit into the item in every language", () => {
    for (const [lang, expected] of [
      ["ru", "Отклонено: у позиции уже максимальное число фото"],
      ["kk", "позицияда фото саны шегіне жетті"],
      ["en", "the item already has the most photos it may hold"],
    ] as const) {
      const t = createTranslate(lang, null);
      const text = photoStatusText("rejected", PHOTO_REJECTED_ITEM_FULL, t);
      expect(text).toContain(expected);
      expect(text).not.toContain(PHOTO_REJECTED_ITEM_FULL);
    }
    const t = createTranslate("ru", null);
    expect(photoStatusText("rejected", "Чужая деталь", t)).toBe("Отклонено: Чужая деталь");
  });
});
