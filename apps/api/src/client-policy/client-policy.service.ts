import { Inject, Injectable } from "@nestjs/common";
import {
  clientPlatforms,
  clientPolicyResponseSchema,
  type ClientInfo,
  type ClientPolicyResponse,
} from "@adclub/contracts";
import { isVersionBelowMinimum } from "@adclub/domain";
import type { Lang } from "@adclub/i18n";
import { ClientUpdateRequiredException } from "../common/errors";
import { ClientPolicySource } from "./client-policy.source";

@Injectable()
export class ClientPolicyService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(ClientPolicySource) private readonly source: ClientPolicySource) {}

  async getPolicy(lang: Lang): Promise<ClientPolicyResponse> {
    const settings = await this.source.getSettings();
    return clientPolicyResponseSchema.parse({
      platforms: Object.fromEntries(
        clientPlatforms.map((platform) => [
          platform,
          { minSupportedVersion: settings.minSupportedVersions[platform] },
        ]),
      ),
      message: settings.updateMessage[lang],
    });
  }

  /**
   * Throws `ClientUpdateRequiredException` when a known client is below
   * its platform's minimum; otherwise returns quietly.
   */
  async assertSupported(client: ClientInfo, lang: Lang): Promise<void> {
    const settings = await this.source.getSettings();
    const minSupportedVersion = settings.minSupportedVersions[client.platform];

    if (isVersionBelowMinimum(client.version, minSupportedVersion)) {
      throw new ClientUpdateRequiredException(settings.updateMessage[lang], {
        platform: client.platform,
        clientVersion: client.version,
        minSupportedVersion,
      });
    }
  }
}
