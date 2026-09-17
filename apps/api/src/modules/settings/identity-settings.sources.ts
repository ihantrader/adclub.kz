import { Inject, Injectable } from "@nestjs/common";
import {
  LoginCodeSettingsSource,
  SessionSettingsSource,
  SignInSettingsSource,
  type LoginCodeSettings,
  type SessionSettings,
  type SignInSettings,
} from "../identity";
import { AppSettings } from "./app-settings";

const DAY_SECONDS = 24 * 60 * 60;

/** Login code thresholds from the `login_code_*` settings. */
@Injectable()
export class SettingsLoginCodeSource extends LoginCodeSettingsSource {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AppSettings) private readonly settings: AppSettings) {
    super();
  }

  async getSettings(): Promise<LoginCodeSettings> {
    const v = await this.settings.values();
    return {
      codeLength: v.login_code_length,
      ttlSeconds: v.login_code_ttl_seconds,
      maxAttempts: v.login_code_max_attempts,
      resendIntervalSeconds: v.login_code_resend_interval_seconds,
      verifyFreeFailures: v.login_code_verify_free_failures,
      verifyDelayBaseSeconds: v.login_code_verify_delay_base_seconds,
      requestsPerPhone: {
        max: v.login_code_requests_per_phone,
        windowSeconds: v.login_code_requests_per_phone_window_seconds,
      },
      requestsPerIp: {
        max: v.login_code_requests_per_ip,
        windowSeconds: v.login_code_requests_per_ip_window_seconds,
      },
      verificationsPerPhone: {
        max: v.login_code_verifications_per_phone,
        windowSeconds: v.login_code_verifications_per_phone_window_seconds,
      },
      smsPerPhoneDaily: { max: v.login_code_sms_per_phone_daily, windowSeconds: DAY_SECONDS },
      smsPerIpDaily: { max: v.login_code_sms_per_ip_daily, windowSeconds: DAY_SECONDS },
    };
  }
}

/** Session lifetimes and refresh thresholds from the `session_*` settings. */
@Injectable()
export class SettingsSessionSource extends SessionSettingsSource {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AppSettings) private readonly settings: AppSettings) {
    super();
  }

  async getSettings(): Promise<SessionSettings> {
    const v = await this.settings.values();
    return {
      accessTokenTtlSeconds: v.session_access_token_ttl_seconds,
      ttlSeconds: {
        mobile: v.session_mobile_ttl_seconds,
        supplier_web: v.session_supplier_web_ttl_seconds,
        // The registry caps it at 12 hours: no stored value above is used.
        admin_web: v.session_admin_web_ttl_seconds,
      },
      refreshReuseGraceSeconds: v.session_refresh_reuse_grace_seconds,
      refreshPerSession: {
        max: v.session_refresh_per_session,
        windowSeconds: v.session_refresh_per_session_window_seconds,
      },
      refreshPerIp: {
        max: v.session_refresh_per_ip,
        windowSeconds: v.session_refresh_per_ip_window_seconds,
      },
    };
  }
}

/** Sign-in step thresholds from the `sign_in_*` and `admin_*` settings. */
@Injectable()
export class SettingsSignInSource extends SignInSettingsSource {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AppSettings) private readonly settings: AppSettings) {
    super();
  }

  async getSettings(): Promise<SignInSettings> {
    const v = await this.settings.values();
    return {
      // The registry caps both at 30 minutes.
      supplierSelectionTtlSeconds: v.sign_in_supplier_selection_ttl_seconds,
      adminTotpTtlSeconds: v.sign_in_admin_totp_ttl_seconds,
      totpAllowedDriftSteps: v.admin_totp_allowed_drift_steps,
      backupCodeCount: v.admin_backup_code_count,
      totpVerifyPerAdmin: {
        max: v.admin_totp_verify_per_admin,
        windowSeconds: v.admin_totp_verify_per_admin_window_seconds,
      },
      totpVerifyPerIp: {
        max: v.admin_totp_verify_per_ip,
        windowSeconds: v.admin_totp_verify_per_ip_window_seconds,
      },
    };
  }
}
