import { Inject, Injectable } from "@nestjs/common";
import type { ClientPlatform } from "@adclub/contracts";
import type { Lang } from "@adclub/i18n";
import { AppSettings } from "../modules/settings";

export interface ClientPolicySettings {
  minSupportedVersions: Record<ClientPlatform, string>;
  updateMessage: Record<Lang, string>;
  /** The app's page in each store (TASK-056); `null` — not set, the app searches the store. */
  storeUrls: { ios: string | null; android: string | null };
}

/**
 * Where the client policy values come from. Read on every request that
 * needs it, so an implementation must be cheap (cache inside it).
 */
export abstract class ClientPolicySource {
  abstract getSettings(): Promise<ClientPolicySettings>;
}

/**
 * The client policy from the settings (`client_min_version_*`,
 * `client_update_message`; ARCHITECTURE 7.4, 4.11): a change applies
 * within the settings cache lifetime, without a restart.
 */
@Injectable()
export class SettingsClientPolicySource extends ClientPolicySource {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AppSettings) private readonly settings: AppSettings) {
    super();
  }

  async getSettings(): Promise<ClientPolicySettings> {
    const v = await this.settings.values();
    return {
      minSupportedVersions: {
        ios: v.client_min_version_ios,
        android: v.client_min_version_android,
        "supplier-web": v.client_min_version_supplier_web,
        "admin-web": v.client_min_version_admin_web,
      },
      updateMessage: v.client_update_message,
      storeUrls: {
        ios: v.client_store_url_ios === "" ? null : v.client_store_url_ios,
        android: v.client_store_url_android === "" ? null : v.client_store_url_android,
      },
    };
  }
}
