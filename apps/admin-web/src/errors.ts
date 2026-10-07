import { isApiError } from "@adclub/api-client";

/**
 * What the admin panel says when a request is refused (SCREENS 2.3, 7.0):
 * the server's verdict in plain Russian. Nothing here decides anything.
 */
function detail<T>(error: unknown, key: string): T | undefined {
  if (!isApiError(error)) return undefined;
  const details = error.details;
  return typeof details === "object" && details !== null && key in details
    ? ((details as Record<string, unknown>)[key] as T)
    : undefined;
}

/** `retryAfterSeconds` of `RATE_LIMITED`, in whole minutes, at least one. */
export function retryMinutes(error: unknown): number {
  const seconds = Number(detail<number>(error, "retryAfterSeconds") ?? 60);
  return Math.max(1, Math.ceil(seconds / 60));
}

export function errorCode(error: unknown): string | null {
  return isApiError(error) ? error.code : null;
}

/** The sign-in screens A-AUTH: phone, code, the second factor. */
export function signInErrorText(error: unknown): string {
  if (!isApiError(error)) return "Что-то пошло не так. Попробуйте ещё раз";
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз";
    case "RATE_LIMITED": {
      const limit = detail<string>(error, "limit");
      if (limit === "login_code_verify_delay") {
        const seconds = Number(detail<number>(error, "retryAfterSeconds") ?? 1);
        return `Подождите ${Math.max(1, Math.ceil(seconds))} с и введите код снова`;
      }
      if (limit === "login_code_verifications_per_phone") {
        return `Попытки исчерпаны. Запросите новый код через ${retryMinutes(error)} мин`;
      }
      return `Слишком много попыток. Попробуйте через ${retryMinutes(error)} мин`;
    }
    case "LOGIN_CODE_DELIVERY_FAILED":
      return "Не удалось отправить код. Попробуйте ещё раз";
    case "LOGIN_CODE_EXPIRED":
      return "Код больше не действует. Запросите новый";
    case "LOGIN_CODE_INVALID": {
      const remaining = Number(detail<number>(error, "attemptsRemaining") ?? 0);
      return remaining > 0
        ? `Неверный код. Осталось попыток: ${remaining}`
        : "Попытки исчерпаны. Запросите новый код";
    }
    case "VALIDATION_ERROR":
      return "Проверьте введённое";
    case "SIGN_IN_STEP_INVALID":
      return "Время на вход истекло. Начните вход заново";
    case "NOT_ADMIN":
      return "У этого номера нет доступа к админке. Права администратора назначает оператор сервера";
    case "TOTP_INVALID":
      return "Неверный код. Проверьте время на телефоне: код приложения-аутентификатора зависит от точного времени";
    default:
      return "Что-то пошло не так. Попробуйте ещё раз";
  }
}

/** A failed action on a screen: the typed values stay (SCREENS 2.3). */
export function actionErrorText(error: unknown): string {
  if (!isApiError(error)) return "Не удалось сохранить. Попробуйте ещё раз";
  switch (error.code) {
    case "NETWORK_ERROR":
      return "Нет связи с сервером — изменение не сохранено. Попробуйте, когда связь вернётся";
    case "RATE_LIMITED":
      return `Слишком много запросов. Попробуйте через ${retryMinutes(error)} мин`;
    case "FORBIDDEN":
      return "Это действие недоступно";
    case "SETTING_OPERATOR_ONLY":
      return "Эту настройку меняет только оператор сервера";
    case "VALIDATION_ERROR":
      return validationText(error) ?? "Проверьте введённое";
    case "NOT_FOUND":
      return "Не найдено — возможно, это уже удалили. Обновите страницу";
    case "SERVICE_UNAVAILABLE":
      return "Сервер временно недоступен. Попробуйте позже";
    default:
      return error.message || "Не удалось сохранить. Попробуйте ещё раз";
  }
}

/** The first message of a `VALIDATION_ERROR` (the server's words, e.g. the version above the release). */
export function validationText(error: unknown): string | null {
  if (!isApiError(error) || error.code !== "VALIDATION_ERROR") return null;
  const details = error.details;
  if (Array.isArray(details)) {
    const first = details[0] as { message?: unknown } | undefined;
    if (first && typeof first.message === "string") return first.message;
  }
  return error.message || null;
}

/** A screen that could not load. */
export function loadErrorText(error: unknown): string {
  return isApiError(error) && error.code === "NETWORK_ERROR"
    ? "Нет связи с сервером"
    : "Не удалось загрузить";
}
