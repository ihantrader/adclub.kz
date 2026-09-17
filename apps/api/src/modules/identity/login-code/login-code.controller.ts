import { Body, Controller, Inject, Ip, Req, Res } from "@nestjs/common";
import {
  apiRoutes,
  requestLoginCodeBodySchema,
  verifyLoginCodeBodySchema,
  type LoginCodeSentResponse,
  type LoginCodeVerifiedResponse,
  type RequestLoginCodeBody,
  type VerifyLoginCodeBody,
} from "@adclub/contracts";
import type { Request, Response } from "express";
import { getRequestClient } from "../../../common/client";
import { ApiRoute } from "../../../common/contract";
import { ZodValidationPipe } from "../../../common/validation";
import { SignInService } from "../session/sign-in.service";
import { deliverSession } from "../session/web-sign-in";
import { LoginCodeService } from "./login-code.service";

@Controller()
export class LoginCodeController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(LoginCodeService) private readonly loginCodes: LoginCodeService,
    @Inject(SignInService) private readonly signIn: SignInService,
  ) {}

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
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<LoginCodeVerifiedResponse> {
    const completed = await this.signIn.signIn({
      phone: body.phone,
      code: body.code,
      deviceName: body.deviceName ?? null,
      supplierId: body.supplierId ?? null,
      client: getRequestClient(request),
      ip: ip ?? null,
    });
    return deliverSession(response, completed.issued, completed.response);
  }
}
