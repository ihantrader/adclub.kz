import { isApiError } from "@adclub/api-client";
import { actionErrorText, retryMinutes } from "../errors";

/**
 * «Показать номер» refused, in words (TASK-036.B): the limit per
 * administrator (`phone_reveal_per_account`), a person who is gone, the
 * network.
 */
export function revealErrorText(error: unknown): string {
  if (!isApiError(error)) return "Не удалось открыть номер. Попробуйте ещё раз";
  switch (error.code) {
    case "RATE_LIMITED":
      return `Слишком много открытых номеров подряд. Попробуйте через ${retryMinutes(error)} мин`;
    case "NOT_FOUND":
      return "Номера больше нет — обновите страницу";
    default:
      return actionErrorText(error);
  }
}
