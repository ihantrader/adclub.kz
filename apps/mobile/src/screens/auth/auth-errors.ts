import { isApiError } from "@adclub/api-client";
import type { LanguageContextValue } from "../../state/language";

/**
 * Wording of the errors M-AUTH-01/02 can answer with (SCREENS 5.1): a
 * network failure and a rate limit are common to both screens, the rest are
 * `verifyLoginCode`'s own. Kept in one place so both screens read an error
 * the same way instead of two slightly different `switch`es.
 */
export function loginErrorText(error: unknown, t: LanguageContextValue["t"]): string {
  if (!isApiError(error)) return t("state.errorText");
  switch (error.code) {
    case "NETWORK_ERROR":
      return t("state.offline");
    case "RATE_LIMITED": {
      const seconds =
        typeof error.details === "object" &&
        error.details !== null &&
        "retryAfterSeconds" in error.details
          ? Number((error.details as { retryAfterSeconds: unknown }).retryAfterSeconds)
          : 0;
      return t("auth.rateLimited", { minutes: String(Math.max(1, Math.ceil(seconds / 60))) });
    }
    case "LOGIN_CODE_DELIVERY_FAILED":
      return t("auth.deliveryFailed");
    case "LOGIN_CODE_EXPIRED":
      return t("auth.codeExpired");
    case "LOGIN_CODE_INVALID": {
      const remaining =
        typeof error.details === "object" &&
        error.details !== null &&
        "attemptsRemaining" in error.details
          ? Number((error.details as { attemptsRemaining: unknown }).attemptsRemaining)
          : 0;
      return remaining > 0
        ? t("auth.codeInvalid", { n: String(remaining) })
        : t("auth.codeExpired");
    }
    case "VALIDATION_ERROR":
      return t("auth.phoneInvalid");
    default:
      return t("state.errorText");
  }
}
