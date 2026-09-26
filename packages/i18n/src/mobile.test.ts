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
    expect(mobileText("ru", "garage.emptyTitle")).toBe(
      "Добавьте автомобиль — каталог покажет только подходящее",
    );
    expect(mobileText("ru", "orders.guestEmptyTitle")).toBe(
      "Здесь будут ваши заявки и коды для получения",
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
