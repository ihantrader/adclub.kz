import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig, type SessionSettings } from "../../../config";

/**
 * Where session lifetimes and refresh thresholds come from (ARCHITECTURE
 * 8.2, 14). **Replacement point**: today `ConfigSessionSettingsSource`
 * reads them from the environment (`SESSION_*`, changing them means
 * restarting the API); TASK-007 swaps in an implementation backed by the
 * settings table by changing the provider in `IdentityModule` only — the
 * same pattern as `LoginCodeSettingsSource`.
 *
 * Read on every sign-in, refresh and access check, so an implementation
 * must be cheap (cache inside it if the source is remote). The token
 * secret is not a setting: it stays in the environment.
 */
export abstract class SessionSettingsSource {
  abstract getSettings(): Promise<SessionSettings>;
}

@Injectable()
export class ConfigSessionSettingsSource extends SessionSettingsSource {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  getSettings(): Promise<SessionSettings> {
    return Promise.resolve(this.config.session.settings);
  }
}
