import { isApiError } from "@adclub/api-client";
import type { LanguageContextValue } from "../../state/language";

/**
 * What a change of the account's garage that the server did not accept
 * tells the person (TASK-029.B): the garage is full (`garage_max_cars`), the
 * car is gone — removed on another phone — or, for anything else, «could
 * not save, check the network». Nothing on the device changed in any case.
 */
export function garageErrorText(error: unknown, t: LanguageContextValue["t"]): string {
  if (isApiError(error)) {
    if (error.code === "GARAGE_LIMIT_REACHED") {
      const details = error.details as { limit?: unknown } | undefined;
      const limit = typeof details?.limit === "number" ? details.limit : "";
      return t("garage.limitReached", { limit });
    }
    if (error.status === 404) return t("garage.carGone");
  }
  return t("garage.changeFailed");
}
