import { Body, Controller, Inject, Ip } from "@nestjs/common";
import {
  apiRoutes,
  requestLoginCodeBodySchema,
  verifyLoginCodeBodySchema,
  type LoginCodeSentResponse,
  type LoginCodeVerifiedResponse,
  type RequestLoginCodeBody,
  type VerifyLoginCodeBody,
} from "@adclub/contracts";
import { ApiRoute } from "../../../common/contract";
import { ZodValidationPipe } from "../../../common/validation";
import { LoginCodeService } from "./login-code.service";

@Controller()
export class LoginCodeController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(LoginCodeService) private readonly loginCodes: LoginCodeService) {}

  @ApiRoute(apiRoutes.requestLoginCode)
  requestLoginCode(
    @Body(new ZodValidationPipe(requestLoginCodeBodySchema)) body: RequestLoginCodeBody,
    @Ip() ip: string | undefined,
  ): Promise<LoginCodeSentResponse> {
    return this.loginCodes.requestCode({ phone: body.phone, channel: body.channel, ip: ip ?? "" });
  }

  @ApiRoute(apiRoutes.verifyLoginCode)
  async verifyLoginCode(
    @Body(new ZodValidationPipe(verifyLoginCodeBodySchema)) body: VerifyLoginCodeBody,
  ): Promise<LoginCodeVerifiedResponse> {
    const verified = await this.loginCodes.verifyCode({ phone: body.phone, code: body.code });
    // No session yet: TASK-005 adds it to this response from `verified`.
    return { status: "verified", phone: verified.phone };
  }
}
