import { describe, expect, it } from "vitest";
import { mobileLocales, mobileText, mobileTextKeys } from "./mobile";
import { languages } from "./translate";

const TAB_KEYS = ["tabs.catalog", "tabs.orders", "tabs.garage", "tabs.profile"] as const;

describe("mobile texts", () => {
  it("has the same, non-empty text keys in all three languages", () => {
    const reference = mobileTextKeys().sort();
    expect(reference.length).toBeGreaterThan(0);
    for (const lang of languages) {
      const keys = Object.keys(mobileLocales[lang])
        .filter((key) => !key.startsWith("$"))
        .sort();
      expect(keys).toEqual(reference);
      for (const key of reference) {
        expect(mobileText(lang, key).trim()).not.toBe("");
      }
    }
  });

  it("says in the Kazakh file that a native speaker has not confirmed it", () => {
    expect(mobileLocales.kk.$about).toMatch(/НЕ ПОДТВЕРЖДЁН НОСИТЕЛЕМ ЯЗЫКА/);
  });

  it("keeps tab labels to one short word per language (SCREENS 9.1, DESIGN 7.11)", () => {
    for (const lang of languages) {
      for (const key of TAB_KEYS) {
        const label = mobileText(lang, key);
        expect(label).not.toMatch(/\s/);
        expect(label.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it("uses the SCREENS wording where SCREENS fixes it", () => {
    // T-START-01, T-START-04, T-CITY-01, T-GAR-01.
    expect(mobileText("ru", "start.chooseLanguage")).toBe(
      "Тілді таңдаңыз · Выберите язык · Choose language",
    );
    expect(mobileText("ru", "city.firstRunTitle")).toBe("Где вы находитесь?");
    expect(mobileText("ru", "city.firstRunText")).toBe(
      "Покажем поставщиков и услуги рядом. Товары доступны по всему Казахстану",
    );
    expect(mobileText("ru", "city.servicesNote")).toBe(
      "Услуги показываются только по выбранному городу",
    );
    expect(mobileText("ru", "city.detectHint")).toBe(
      "Чтобы показать поставщиков и услуги в вашем городе",
    );
    // T-GAR-01's fixed phrase was one sentence combining the two; TASK-028.B
    // (D-063) unifies the garage's empty state with the catalog's «Добавьте
    // автомобиль» (heading + explanation, one component for both screens),
    // so the garage now uses the same two texts instead of its own sentence.
    // The exact SCREENS.md wording is superseded by this instruction and is
    // for the Product Owner to fold back into SCREENS.md (see the report).
    expect(mobileText("ru", "car.needCarTitle")).toBe("Добавьте автомобиль");
    expect(mobileText("ru", "car.needCarText")).toBe(
      "Каталог покажет только то, что подходит вашему автомобилю. Регистрация не нужна",
    );
    expect(mobileText("ru", "orders.guestEmptyTitle")).toBe(
      "Здесь будут ваши заявки и коды для получения",
    );
    // TASK-030: the orders (T-GATE-01, T-ORD-01, T-ORD-04…07, M-ORD-01…03).
    expect(mobileText("ru", "auth.gateOrder")).toBe(
      "Войдите, чтобы оформить заявку и получить код",
    );
    expect(mobileText("ru", "checkout.phoneNotice")).toBe(
      "Имя и номер телефона передадим поставщику, когда он примет заявку",
    );
    expect(mobileText("ru", "checkout.deliveryNote")).toBe(
      "Условия и стоимость доставки согласуете с поставщиком",
    );
    expect(mobileText("ru", "order.showCode")).toBe("Покажите QR или назовите код сотруднику");
    expect(mobileText("ru", "order.codeLater")).toBe("Код понадобится после принятия заявки");
    expect(mobileText("ru", "order.offlineNote")).toBe("Обновлено в {time}. Статус мог измениться");
    expect(mobileText("ru", "checkout.priceChangedText")).toBe(
      "Цена изменилась: было {was}, стало {now}",
    );
    expect(mobileText("ru", "checkout.duplicateTitle")).toBe(
      "У вас уже есть заявка на это предложение",
    );
    expect(mobileText("ru", "order.cancelConfirmText")).toBe(
      "Поставщик получит уведомление об отмене",
    );
    expect(mobileText("ru", "orders.activeEmptyTitle")).toBe("Активных заявок нет");
    expect(mobileText("ru", "orders.historyEmptyTitle")).toBe("Здесь появятся выполненные заявки");
    expect(mobileText("ru", "orders.historyOffline")).toBe("История доступна при подключении");
    expect(mobileText("ru", "orders.readOnlyBanner")).toBe(
      "Приложение нужно обновить. Сейчас доступны только коды заявок",
    );
    expect(mobileText("ru", "orderStatus.created.title")).toBe("Ждём ответа поставщика");
    expect(mobileText("ru", "orderStatus.reserveExpired.text")).toBe(
      "Заявка закрыта. Оформите новую, если товар ещё нужен",
    );
  });

  it("shows the language options in their own language, without flags", () => {
    for (const lang of languages) {
      expect(mobileText(lang, "language.kk")).toBe("Қазақша");
      expect(mobileText(lang, "language.ru")).toBe("Русский");
      expect(mobileText(lang, "language.en")).toBe("English");
    }
  });

  it("keeps no capitalised words and no letter spacing (DESIGN 7.11)", () => {
    for (const lang of languages) {
      for (const key of mobileTextKeys()) {
        // Words of three letters or more in caps: "App Store", "QR", "AI" excluded.
        expect(mobileText(lang, key)).not.toMatch(/\b[А-ЯЁӘҒҚҢӨҰҮҺІ]{3,}\b/);
      }
    }
  });
});
