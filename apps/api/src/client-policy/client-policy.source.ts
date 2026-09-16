import { Inject, Injectable } from "@nestjs/common";
import type { ClientPlatform } from "@adclub/contracts";
import type { Lang } from "@adclub/i18n";
import { APP_CONFIG, type AppConfig } from "../config";

export interface ClientPolicySettings {
  minSupportedVersions: Record<ClientPlatform, string>;
  updateMessage: Record<Lang, string>;
}

/**
 * Where the client policy values come from. **Replacement point**: today
 * `ConfigClientPolicySource` reads them from the environment (changing
 * them means restarting the API); TASK-007 swaps in an implementation
 * backed by the settings table, editable by an administrator, by
 * changing the provider in `ClientPolicyModule` only.
 *
 * Read on every request that needs it, so an implementation must be cheap
 * (cache inside the implementation if the source is remote).
 */
export abstract class ClientPolicySource {
  abstract getSettings(): Promise<ClientPolicySettings>;
}

@Injectable()
export class ConfigClientPolicySource extends ClientPolicySource {
  private readonly settings: ClientPolicySettings;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.settings = config.clientPolicy;
  }

  getSettings(): Promise<ClientPolicySettings> {
    return Promise.resolve(this.settings);
  }
}
