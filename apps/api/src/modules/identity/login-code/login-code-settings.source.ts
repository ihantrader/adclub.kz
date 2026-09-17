import type { RateLimitSettings } from "../../../config";

/** Login code thresholds (ARCHITECTURE 8.1, 14): the `login_code_*` settings. */
export interface LoginCodeSettings {
  codeLength: number;
  ttlSeconds: number;
  /** Wrong entries a single code survives; the last one invalidates it. */
  maxAttempts: number;
  /** Minimum time between two codes for one number, whatever the channel. */
  resendIntervalSeconds: number;
  /** Wrong entries allowed without any delay before the next try. */
  verifyFreeFailures: number;
  /** Delay after the first delayed failure; doubles with each next one. */
  verifyDelayBaseSeconds: number;
  requestsPerPhone: RateLimitSettings;
  requestsPerIp: RateLimitSettings;
  verificationsPerPhone: RateLimitSettings;
  smsPerPhoneDaily: RateLimitSettings;
  smsPerIpDaily: RateLimitSettings;
}

/**
 * Where login code thresholds come from. Provided by the settings module
 * (`SettingsLoginCodeSource`, values from `app_setting`, ARCHITECTURE
 * 4.11), so a change takes effect without a restart. Read on every
 * request; implementations cache.
 */
export abstract class LoginCodeSettingsSource {
  abstract getSettings(): Promise<LoginCodeSettings>;
}
