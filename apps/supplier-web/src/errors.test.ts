import { ApiError } from "@adclub/api-client";
import { supplierText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import { loginErrorText, saveErrorText } from "./errors";
import type { Translate } from "./i18n";

const t: Translate = (key, params) => supplierText("ru", key, params);

function error(code: ApiError["code"], status: number, details?: unknown): ApiError {
  return new ApiError({ code, message: "m", status, retryable: false, details });
}

describe("texts of the sign-in errors (SCREENS 5.1, T-AUTH-03/04)", () => {
  it("counts the attempts left, and says they are over when none is", () => {
    expect(loginErrorText(error("LOGIN_CODE_INVALID", 400, { attemptsRemaining: 2 }), t)).toBe(
      "Неверный код. Осталось попыток: 2",
    );
    expect(loginErrorText(error("LOGIN_CODE_INVALID", 400, { attemptsRemaining: 0 }), t, 150)).toBe(
      "Слишком много попыток. Запросите новый код через 3 мин",
    );
    expect(
      loginErrorText(
        error("RATE_LIMITED", 429, {
          limit: "login_code_verifications_per_phone",
          retryAfterSeconds: 600,
        }),
        t,
      ),
    ).toBe("Слишком много попыток. Запросите новый код через 10 мин");
  });

  it("tells a short pause after a wrong code from the end of the attempts", () => {
    expect(
      loginErrorText(
        error("RATE_LIMITED", 429, { limit: "login_code_verify_delay", retryAfterSeconds: 3 }),
        t,
      ),
    ).toBe("Подождите 3 с и введите код ещё раз");
  });

  it("names an expired code, a failed delivery and a lost connection", () => {
    expect(loginErrorText(error("LOGIN_CODE_EXPIRED", 400), t)).toBe(
      "Код устарел. Запросите новый",
    );
    expect(loginErrorText(error("LOGIN_CODE_DELIVERY_FAILED", 503), t)).toBe(
      "Не удалось отправить код. Попробуйте ещё раз",
    );
    expect(loginErrorText(error("NETWORK_ERROR", 0), t)).toBe("Нет связи с сервером");
    expect(loginErrorText(error("SIGN_IN_STEP_INVALID", 401), t)).toBe(
      "Время на выбор вышло. Войдите ещё раз",
    );
  });

  it("keeps the typed values and says when to save again (SCREENS 2.3)", () => {
    expect(saveErrorText(error("NETWORK_ERROR", 0), t)).toBe(
      "Нет сети. Введённое не потеряется — сохраните, когда связь появится",
    );
    expect(saveErrorText(error("SERVICE_UNAVAILABLE", 503), t)).toBe(
      "Не удалось сохранить. Попробуйте ещё раз",
    );
  });
});
