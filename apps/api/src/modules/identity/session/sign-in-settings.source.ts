import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig, type SignInSettings } from "../../../config";

/**
 * Where the thresholds of the cabinet and admin sign-in steps come from
 * (ARCHITECTURE 8.1, 14): step lifetimes, the size of a backup code set,
 * the tolerated clock drift and the second factor rate limits.
 * **Replacement point**: today `ConfigSignInSettingsSource` reads the
 * environment (`SIGN_IN_*`, `ADMIN_TOTP_*`, `ADMIN_BACKUP_CODE_COUNT`);
 * TASK-007 swaps in an implementation backed by the settings table by
 * changing the provider in `IdentityModule` only — as for
 * `LoginCodeSettingsSource` and `SessionSettingsSource`. Read on every
 * sign-in step. The TOTP encryption key is not a setting.
 */
export abstract class SignInSettingsSource {
  abstract getSettings(): Promise<SignInSettings>;
}

@Injectable()
export class ConfigSignInSettingsSource extends SignInSettingsSource {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  getSettings(): Promise<SignInSettings> {
    return Promise.resolve(this.config.signIn.settings);
  }
}
