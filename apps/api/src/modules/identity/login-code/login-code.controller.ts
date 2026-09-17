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
import { isWebSessionKind, setRefreshCookie } from "../session/session-cookie";
import { SignInService } from "../session/sign-in.service";
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
    const { response: verified, issued } = await this.signIn.signIn({
      phone: body.phone,
      code: body.code,
      deviceName: body.deviceName ?? null,
      client: getRequestClient(request),
      ip: ip ?? null,
    });
    const kind = issued.tokens.kind;
    if (!isWebSessionKind(kind)) {
      return verified;
    }
    // Web sessions (issued once TASK-006 opens them): the refresh token
    // goes to the HttpOnly cookie only.
    setRefreshCookie(
      response,
      kind,
      issued.tokens.refreshToken,
      issued.sessionExpiresAt,
      new Date(),
    );
    const { refreshToken: _inCookie, ...tokens } = verified.session;
    return { ...verified, session: tokens };
  }
}
