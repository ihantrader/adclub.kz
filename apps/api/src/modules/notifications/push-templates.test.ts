import { notificationKinds } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { notificationStatusOf } from "./notifications.service";
import { maskToken } from "./push-provider";
import {
  checkPushTemplates,
  placeholdersOf,
  PUSH_BODY_MAX_LENGTH,
  PUSH_LANGUAGES,
  pushLangOf,
  PushRenderError,
  pushTemplates,
  renderPushText,
  type PushTemplateCode,
} from "./push-templates";

describe("push templates (SCREENS 8.4, TASK-051)", () => {
  it("are sound: every language, the same placeholders, room for the values", () => {
    expect(checkPushTemplates()).toEqual([]);
  });

  it("are of kinds the one list knows", () => {
    for (const template of Object.values(pushTemplates)) {
      expect(notificationKinds).toContain(template.kind);
    }
  });

  it("keep the Russian of SCREENS 8.4 word for word", () => {
    expect(pushTemplates.order_accepted.texts.ru).toBe("{supplier} принял заявку: {item}");
    expect(pushTemplates.order_ready.texts.ru).toBe("Можно забирать: {item}. Резерв до {until}");
    expect(pushTemplates.reserve_expiring.texts.ru).toBe("Резерв заканчивается в {time}: {item}");
    expect(pushTemplates.order_declined.texts.ru).toBe(
      "Поставщик отказал по заявке: {item}. Посмотрите другие предложения",
    );
    expect(pushTemplates.order_closed.texts.ru).toBe(
      "Заявка закрыта: {item}. Не получали? Сообщите нам",
    );
    expect(pushTemplates.order_expired_no_response.texts.ru).toBe(
      "Поставщик не ответил вовремя — заявка отменена. Посмотрите другие предложения",
    );
    expect(pushTemplates.term_confirmed.texts.ru).toBe("Поставщик подтвердил срок: до {date}");
    expect(pushTemplates.time_confirmed.texts.ru).toBe("Ждём вас {date} в {time}, {supplier}");
    expect(pushTemplates.review_text_rejected.texts.ru).toBe(
      "Отзыв не опубликован: {reason}. Можно исправить",
    );
    expect(pushTemplates.payment_failed.texts.ru).toBe(
      "Не удалось оплатить подписку. Обновите способ оплаты, чтобы сохранить доступ",
    );
  });

  it("render with every value and refuse a missing or an unknown one", () => {
    expect(
      renderPushText("order_accepted", "kk", { supplier: "Автомаркет", item: "Колодки" }),
    ).toBe("Автомаркет өтінімді қабылдады: Колодки");
    expect(() => renderPushText("order_accepted", "ru", { item: "x" })).toThrow(PushRenderError);
    expect(() =>
      renderPushText("order_accepted", "ru", { supplier: "a", item: "b", phone: "+7" }),
    ).toThrow(PushRenderError);
  });

  it("collapse a value to one line and cut a text too long instead of refusing it", () => {
    expect(renderPushText("order_closed", "en", { item: "Pads\n\tfront" })).toBe(
      "Order closed: Pads front. Didn't receive it? Let us know",
    );
    const cut = renderPushText("order_closed", "ru", { item: "я".repeat(PUSH_BODY_MAX_LENGTH) });
    expect([...cut].length).toBe(PUSH_BODY_MAX_LENGTH);
    expect(cut.endsWith("я…")).toBe(true);
  });

  it("render every template in every language with its own placeholders", () => {
    for (const [code, template] of Object.entries(pushTemplates)) {
      for (const lang of PUSH_LANGUAGES) {
        const values = Object.fromEntries(
          placeholdersOf(template.texts[lang]).map((name) => [name, "X"]),
        );
        expect(renderPushText(code as PushTemplateCode, lang, values)).not.toMatch(/[{}]/);
      }
    }
  });

  it("speak the account's language, Russian without one", () => {
    expect(pushLangOf("kk")).toBe("kk");
    expect(pushLangOf("en")).toBe("en");
    expect(pushLangOf(null)).toBe("ru");
    expect(pushLangOf("tr")).toBe("ru");
  });
});

describe("a notification's status from its deliveries", () => {
  it("is sent once one device got it, queued while one is on its way, else the worst outcome", () => {
    expect(notificationStatusOf([])).toBe("no_device");
    expect(notificationStatusOf(["failed", "sent"])).toBe("sent");
    expect(notificationStatusOf(["queued", "failed"])).toBe("queued");
    expect(notificationStatusOf(["sending"])).toBe("queued");
    expect(notificationStatusOf(["failed", "unknown"])).toBe("unknown");
    expect(notificationStatusOf(["failed", "cancelled"])).toBe("failed");
    expect(notificationStatusOf(["cancelled"])).toBe("cancelled");
  });
});

describe("maskToken", () => {
  it("keeps six characters at the start and four at the end", () => {
    const token = `abcdefGHIJKLMNOPQRSTUVWXYZ${"1".repeat(100)}wxyz`;
    expect(maskToken(token)).toBe("abcdef…wxyz");
    expect(maskToken("short")).toBe("…");
  });
});
