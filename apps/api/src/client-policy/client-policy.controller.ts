import { Controller, Headers, Inject } from "@nestjs/common";
import { apiRoutes, type ClientPolicyResponse } from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ApiRoute } from "../common/contract";
import { ClientPolicyService } from "./client-policy.service";

@Controller()
export class ClientPolicyController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(ClientPolicyService) private readonly policy: ClientPolicyService) {}

  @ApiRoute(apiRoutes.getClientPolicy)
  getClientPolicy(
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<ClientPolicyResponse> {
    return this.policy.getPolicy(pickLanguage(acceptLanguage));
  }
}
