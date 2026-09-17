import type { RateLimitSettings } from "../../../config";

/**
 * Thresholds of the cabinet and admin sign-in steps (ARCHITECTURE 8.1,
 * 14): the `sign_in_*`, `admin_totp_*` and `admin_backup_code_count`
 * settings.
 */
export interface SignInSettings {
  /** How long a started company choice stays usable. */
  supplierSelectionTtlSeconds: number;
  /** How long an admin sign-in may wait for the second factor (setup included). */
  adminTotpTtlSeconds: number;
  /** Authenticator codes this many 30-second steps early or late are accepted. */
  totpAllowedDriftSteps: number;
  /** Backup codes in one set. */
  backupCodeCount: number;
  /** Second factor checks (right or wrong) per administrator. */
  totpVerifyPerAdmin: RateLimitSettings;
  /** Second factor checks per client address. */
  totpVerifyPerIp: RateLimitSettings;
}

/**
 * Where the sign-in step thresholds come from. Provided by the settings
 * module (`SettingsSignInSource`, ARCHITECTURE 4.11). Read on every
 * sign-in step. The TOTP encryption key is not a setting.
 */
export abstract class SignInSettingsSource {
  abstract getSettings(): Promise<SignInSettings>;
}
