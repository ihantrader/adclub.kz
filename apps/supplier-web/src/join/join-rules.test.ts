import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import { createTranslate } from "../translate";
import { emptyJoinForm, joinBody, joinErrors, joinRefusal, supplierTypeOf } from "./join-rules";

const ru = createTranslate("ru", null);
const kk = createTranslate("kk", null);
const CITY = "4b0a1c35-8d7e-4d55-9a7e-5d1f0f6c9a11";

const filled = {
  ...emptyJoinForm,
  companyName: " Детали Юг ",
  bin: "0807 4000 0128",
  cityId: CITY,
  goods: true,
  contactName: "Марат",
  phone: "+7 705 777 12 34",
  consent: true,
};

describe("S-PUB-01 «Заявка на подключение» (TASK-077)", () => {
  it("checks the BIN's check digit before sending", () => {
    expect(joinErrors(filled, ru)).toEqual({});
    expect(joinErrors({ ...filled, bin: "080740000129" }, ru).bin).toBe(
      "Проверьте БИН: в нём ошибка",
    );
    expect(joinErrors({ ...filled, bin: "0807" }, ru).bin).toBe("БИН — 12\u00a0цифр");
    expect(joinErrors({ ...filled, bin: "080740000129" }, kk).bin).toBe(
      "БСН-ді тексеріңіз: онда қате бар",
    );
  });

  it("asks for every field, the offer and the consent", () => {
    expect(Object.keys(joinErrors(emptyJoinForm, ru)).sort()).toEqual(
      ["bin", "cityId", "companyName", "consent", "contactName", "phone", "type"].sort(),
    );
    expect(joinBody(emptyJoinForm, "ru")).toBeNull();
    expect(joinBody({ ...filled, consent: false }, "ru")).toBeNull();
    expect(joinBody({ ...filled, phone: "+7\u00a0495\u00a0123 45 67" }, "ru")).toBeNull();
  });

  it("sends goods, services or both, normalized, in the page's language", () => {
    expect(supplierTypeOf({ goods: true, services: true })).toBe("both");
    expect(supplierTypeOf({ goods: false, services: true })).toBe("services");
    expect(supplierTypeOf({ goods: false, services: false })).toBeNull();
    expect(joinBody({ ...filled, services: true }, "kk")).toEqual({
      companyName: "Детали Юг",
      bin: "080740000128",
      cityId: CITY,
      type: "both",
      contactName: "Марат",
      phone: "+77057771234",
      consent: true,
      language: "kk",
    });
    // The hidden field goes as it is: the server drops such a request.
    expect(joinBody({ ...filled, website: "http://spam" }, "ru")?.website).toBe("http://spam");
  });

  it("reads the server's refusals in words: the wait, the outage, the field", () => {
    const limited = new ApiError({
      status: 429,
      code: "RATE_LIMITED",
      message: "",
      retryable: true,
      details: { limit: "supplier_lead_per_phone", retryAfterSeconds: 3600 },
    });
    expect(joinRefusal(limited, ru).text).toBe(
      "Слишком много заявок. Попробуйте через 60\u00a0мин",
    );
    const down = new ApiError({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "",
      retryable: true,
    });
    expect(joinRefusal(down, ru).text).toBe("Сейчас не удалось отправить. Попробуйте позже");
    const invalid = new ApiError({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "",
      retryable: false,
      details: [{ path: "bin", message: "x" }],
    });
    expect(joinRefusal(invalid, ru)).toEqual({
      fields: { bin: "Проверьте БИН: в нём ошибка" },
      text: null,
    });
  });
});
