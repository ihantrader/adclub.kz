import { describe, expect, it } from "vitest";
import { formatText } from "./plural";
import {
  hasSupplierText,
  supplierLocales,
  supplierText,
  supplierTextKeys,
  type SupplierTextKey,
} from "./supplier";
import { languages } from "./translate";

const TAB_KEYS = ["tabs.orders", "tabs.offers", "tabs.scan", "tabs.more"] as const;

describe("supplier cabinet texts", () => {
  it("has the same, non-empty text keys in all three languages", () => {
    const reference = supplierTextKeys().sort();
    expect(reference.length).toBeGreaterThan(0);
    for (const lang of languages) {
      const keys = Object.keys(supplierLocales[lang])
        .filter((key) => !key.startsWith("$"))
        .sort();
      expect(keys).toEqual(reference);
      for (const key of reference) {
        expect(supplierText(lang, key).trim()).not.toBe("");
      }
    }
  });

  it("keeps the same placeholders in every language", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of supplierTextKeys()) {
      const reference = placeholders(supplierLocales.ru[key]);
      for (const lang of languages) {
        expect(placeholders((supplierLocales[lang] as Record<string, string>)[key]!)).toEqual(
          reference,
        );
      }
    }
  });

  it("says in the Kazakh file that a native speaker has not confirmed it", () => {
    expect(supplierLocales.kk.$about).toMatch(/НЕ ПОДТВЕРЖДЁН НОСИТЕЛЕМ ЯЗЫКА/);
  });

  it("keeps tab labels to one short word per language (SCREENS 9.1, DESIGN 7.11)", () => {
    for (const lang of languages) {
      for (const key of TAB_KEYS) {
        const label = supplierText(lang, key);
        expect(label).not.toMatch(/\s/);
        expect(label.length).toBeLessThanOrEqual(11);
      }
    }
  });

  it("uses the SCREENS wording where SCREENS fixes it", () => {
    // S-AUTH-01, SCREENS 2.8 / 6.0, T-AUTH-01…04, T-SUP-01, T-SUP-03…05, S-INST-01.
    expect(supplierText("ru", "auth.notMember")).toBe(
      "Этот номер не привязан к кабинету поставщика. Если вы сотрудник, попросите коллегу добавить вас. Если хотите стать партнёром — оставьте заявку",
    );
    expect(supplierText("ru", "auth.accessClosed")).toBe(
      "Доступ к кабинету закрыт. Обратитесь к коллегам или администратору клуба",
    );
    expect(supplierText("ru", "auth.channelHint")).toBe("Код придёт в WhatsApp");
    expect(supplierText("ru", "auth.fellBackToSms")).toBe("WhatsApp недоступен — отправили SMS");
    expect(supplierText("ru", "auth.codeInvalid", { n: 2 })).toBe(
      "Неверный код. Осталось попыток: 2",
    );
    expect(supplierText("ru", "auth.attemptsExhausted", { n: 5 })).toBe(
      "Слишком много попыток. Запросите новый код через 5 мин",
    );
    expect(supplierText("ru", "banner.pausedAdmin")).toBe(
      "Предложения временно сняты с витрины администратором клуба. Текущие заявки нужно выполнить",
    );
    expect(supplierText("ru", "banner.pausedBilling")).toBe(
      "Предложения сняты с витрины: подписка не оплачена. Текущие заявки нужно выполнить",
    );
    expect(supplierText("ru", "banner.blocked")).toBe("Кабинет заблокирован администратором клуба");
    expect(supplierText("ru", "team.explanation", { n: 5 })).toBe(
      "Уведомление о каждой заявке отправляется каждому сотруднику отдельно. Уведомления получают не больше 5 сотрудников",
    );
    expect(supplierText("ru", "team.removeText", { name: "Марат" })).toBe(
      "Марат сразу потеряет доступ и перестанет получать уведомления. Вернуть доступ сможет только администратор клуба",
    );
    expect(supplierText("ru", "team.lastMember")).toBe(
      "В компании должен остаться хотя бы один сотрудник",
    );
    expect(supplierText("ru", "team.limitReached", { n: 5 })).toBe("Достигнут предел — 5");
    expect(supplierText("ru", "install.text")).toBe(
      "Кабинет откроется одним нажатием, как приложение",
    );
    expect(supplierText("ru", "company.hoursHint")).toBe(
      "Без часов работы предложения не показываются клиентам",
    );
    expect(supplierText("ru", "placeholder.text")).toBe(
      "Раздел появится в следующем обновлении кабинета",
    );
    // S-OFF-01…03 and TASK-032.
    expect(supplierText("ru", "offers.withdrawActive.many", { n: 5 })).toBe(
      "По этому предложению 5 активных заявок — их нужно выполнить",
    );
    expect(supplierText("ru", "offers.activeOrders", { n: 2 })).toBe("Активные заявки: 2");
    expect(supplierText("ru", "offers.newPriceHint")).toBe("Новая цена — для новых заявок");
    expect(supplierText("ru", "offers.emptyTitle")).toBe("Предложений пока нет");
    expect(supplierText("ru", "offers.add")).toBe("Добавить позицию");
    expect(supplierText("ru", "offers.return")).toBe("Вернуть в продажу");
    expect(supplierText("ru", "offerSearch.already")).toBe("Уже в ваших предложениях");
    expect(supplierText("ru", "offerSearch.notFound")).toBe(
      "Позиции нет в справочнике. Напишите администратору клуба",
    );
    expect(supplierText("ru", "offerSearch.rateLimited", { seconds: 30 })).toBe(
      "Слишком много поисков, подождите 30 с",
    );
    expect(supplierText("ru", "offers.error.warrantyContacts")).toBe(
      "Уберите телефон, ссылку или e-mail из гарантии",
    );
    expect(supplierText("ru", "offerForm.previewNoHours")).toBe(
      "Задайте часы работы, иначе клиенты не увидят предложение",
    );
    expect(supplierText("ru", "offerForm.preview")).toBe("Клиент увидит");
    expect(
      supplierText("ru", "offerForm.previewPickup", {
        when: supplierText("ru", "offerForm.tomorrow", { date: "14 марта" }),
      }),
    ).toBe("Самовывоз — завтра, 14 марта");
    expect(supplierText("ru", "company.deliveryDefault")).toBe(
      "Доставка по умолчанию для новых предложений",
    );
    // S-ORD-01…03, S-SCAN-01…04, T-SCAN-01 (TASK-033).
    expect(supplierText("ru", "orders.emptyNew")).toBe("Новых заявок нет");
    expect(supplierText("ru", "orders.emptyNewText")).toBe(
      "Уведомления о новых заявках приходят в WhatsApp",
    );
    expect(supplierText("ru", "orders.emptyInProgress")).toBe("Заявок в работе нет");
    expect(supplierText("ru", "orders.customerHidden")).toBe(
      "Телефон откроется после принятия заявки",
    );
    expect(supplierText("ru", "orders.priceFixed")).toBe("Цена зафиксирована на момент оформления");
    // `when` carries its own preposition: «в 14:02», «вчера в 14:02» (TASK-033.A).
    expect(
      supplierText("ru", "orders.conflict.accepted", {
        who: "Ерлан",
        when: supplierText("ru", "orders.at.yesterday", { time: "14:02" }),
      }),
    ).toBe("Заявку уже принял Ерлан вчера в 14:02");
    expect(supplierText("ru", "orders.declineTitle")).toBe("Отказать клиенту?");
    expect(supplierText("ru", "orders.withdrawTitle")).toBe("Снять это предложение с продажи?");
    expect(supplierText("ru", "scan.camera.denied")).toBe(
      "Разрешите доступ к камере в настройках браузера",
    );
    expect(supplierText("ru", "scan.foreignQr")).toBe("Это не QR заявки клуба");
    expect(supplierText("ru", "scan.result.notFound")).toBe("Код не найден. Проверьте цифры");
    expect(supplierText("ru", "scan.result.otherSupplier")).toBe(
      "Эта заявка оформлена у другого поставщика",
    );
    expect(supplierText("ru", "scan.result.closed", { when: "6 октября", who: "Айжан" })).toBe(
      "Заявка уже выдана 6 октября, закрыл(а) Айжан",
    );
    expect(supplierText("ru", "scan.result.responseExpired")).toBe(
      "Заявка истекла без ответа — закрыть её нельзя",
    );
    expect(supplierText("ru", "scan.result.offline")).toBe(
      "Нет связи. Запишите код клиента и закройте заявку, когда связь появится",
    );
    expect(supplierText("ru", "scan.result.rateLimited", { n: 12 })).toBe(
      "Слишком много неверных кодов. Попробуйте через 12 мин",
    );
    expect(supplierText("ru", "scan.lateText", { when: "вчера, 18:00" })).toBe(
      "Срок заявки истёк вчера, 18:00. Если клиент был у вас вовремя, заявку можно закрыть",
    );
  });

  it("shows the language options in their own language", () => {
    for (const lang of languages) {
      expect(supplierText(lang, "language.kk")).toBe("Қазақша");
      expect(supplierText(lang, "language.ru")).toBe("Русский");
      expect(supplierText(lang, "language.en")).toBe("English");
    }
  });

  it("never breaks on a key it does not know: the key itself, with or without values", () => {
    const missing = "offers.reason.somethingNew" as SupplierTextKey;
    for (const lang of languages) {
      expect(supplierText(lang, missing)).toBe("offers.reason.somethingNew");
      expect(() => supplierText(lang, missing, { n: 3 })).not.toThrow();
      expect(supplierText(lang, missing, { n: 3 })).toBe("offers.reason.somethingNew");
    }
    expect(hasSupplierText("offers.reason.somethingNew")).toBe(false);
    expect(hasSupplierText("offers.title")).toBe(true);
    expect(hasSupplierText("$about")).toBe(false);
    expect(formatText(undefined, { n: 1 })).toBe("");
  });

  it("keeps no capitalised words (DESIGN 7.4)", () => {
    for (const lang of languages) {
      for (const key of supplierTextKeys()) {
        // Words of three letters or more in caps; «БИН»/«БСН», «SMS», «QR» are names.
        const text = supplierText(lang, key).replace(/\b(БИН|БСН|BIN|SMS)\b/g, "");
        expect(text).not.toMatch(/\b[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]{3,}\b/u);
      }
    }
  });
});
