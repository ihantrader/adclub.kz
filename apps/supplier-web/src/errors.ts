import { isApiError } from "@adclub/api-client";
import type { Translate } from "./i18n";

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

export function rateLimitName(error: unknown): string | undefined {
  return detail<string>(error, "limit");
}

/**
 * Wording of the errors S-AUTH-01/02 can answer with (as M-AUTH-01/02,
 * SCREENS 5.1): a network failure and a rate limit are common to both
 * screens, the rest are `verifyLoginCode`'s own. `resendInSeconds` — how long
 * until a new code may be requested, for «попытки исчерпаны» (T-AUTH-04).
 */
export function loginErrorText(error: unknown, t: Translate, resendInSeconds = 0): string {
  if (!isApiError(error)) return t("common.errorText");
  switch (error.code) {
    case "NETWORK_ERROR":
      return t("auth.connectionFailed");
    case "RATE_LIMITED": {
      const limit = rateLimitName(error);
      // A short pause after a wrong code, not the end of the attempts.
      if (limit === "login_code_verify_delay") {
        const seconds = Number(detail<number>(error, "retryAfterSeconds") ?? 1);
        return t("auth.waitSeconds", { seconds: Math.max(1, Math.ceil(seconds)) });
      }
      if (limit === "login_code_verifications_per_phone") {
        return t("auth.attemptsExhausted", { n: retryMinutes(error) });
      }
      return t("auth.rateLimited", { minutes: retryMinutes(error) });
    }
    case "LOGIN_CODE_DELIVERY_FAILED":
      return t("auth.deliveryFailed");
    case "LOGIN_CODE_EXPIRED":
      return t("auth.codeExpired");
    case "LOGIN_CODE_INVALID": {
      const remaining = Number(detail<number>(error, "attemptsRemaining") ?? 0);
      return remaining > 0
        ? t("auth.codeInvalid", { n: remaining })
        : t("auth.attemptsExhausted", { n: Math.max(1, Math.ceil(resendInSeconds / 60)) });
    }
    case "VALIDATION_ERROR":
      return t("auth.phoneInvalid");
    case "SIGN_IN_STEP_INVALID":
      return t("auth.stepExpired");
    default:
      return t("common.errorText");
  }
}

/** A failed save: the typed values stay (SCREENS 2.3); the text says whether to wait for the network. */
export function saveErrorText(error: unknown, t: Translate): string {
  if (isApiError(error) && error.code === "NETWORK_ERROR") return t("common.saveOffline");
  if (isApiError(error) && error.code === "RATE_LIMITED") {
    return t("common.tooManyRequests", { minutes: retryMinutes(error) });
  }
  return t("common.saveFailed");
}
