import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig, type LoginCodeSettings } from "../../../config";

/**
 * Where login code thresholds come from (ARCHITECTURE 8.1, 14).
 * **Replacement point**: today `ConfigLoginCodeSettingsSource` reads them
 * from the environment (`LOGIN_CODE_*`, changing them means restarting
 * the API); TASK-007 swaps in an implementation backed by the settings
 * table by changing the provider in `IdentityModule` only — the same
 * pattern as `ClientPolicySource`.
 *
 * Read on every request, so an implementation must be cheap (cache inside
 * it if the source is remote).
 */
export abstract class LoginCodeSettingsSource {
  abstract getSettings(): Promise<LoginCodeSettings>;
}

@Injectable()
export class ConfigLoginCodeSettingsSource extends LoginCodeSettingsSource {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  getSettings(): Promise<LoginCodeSettings> {
    return Promise.resolve(this.config.loginCode.settings);
  }
}
