import { Body, Controller, Inject, Ip, Req, Res } from "@nestjs/common";
import {
  apiRoutes,
  selectSupplierBodySchema,
  totpSetupBodySchema,
  totpSetupConfirmBodySchema,
  totpVerifyBodySchema,
  type SelectSupplierBody,
  type SignInCompletedResponse,
  type TotpSetupBody,
  type TotpSetupCompletedResponse,
  type TotpSetupConfirmBody,
  type TotpSetupResponse,
  type TotpVerifiedResponse,
  type TotpVerifyBody,
} from "@adclub/contracts";
import type { Request, Response } from "express";
import { ApiRoute } from "../../../common/contract";
import { ZodValidationPipe } from "../../../common/validation";
import { AdminAuthService } from "../admin/admin-auth.service";
import { SignInService } from "./sign-in.service";
import { clearSignInStepCookie, readSignInStepBinding } from "./sign-in-step-cookie";
import { deliverSession } from "./web-sign-in";

/**
 * The steps after the login code (ARCHITECTURE 8.1): the company choice of
 * the supplier cabinet and the admin second factor. Public routes — the
 * proof is the step token together with the step cookie of the client
 * that passed the code; the sessions they issue are web sessions.
 */
@Controller()
export class SignInStepController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SignInService) private readonly signIn: SignInService,
    @Inject(AdminAuthService) private readonly adminAuth: AdminAuthService,
  ) {}

  @ApiRoute(apiRoutes.selectSupplier)
  async selectSupplier(
    @Body(new ZodValidationPipe(selectSupplierBodySchema)) body: SelectSupplierBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<SignInCompletedResponse> {
    const completed = await this.signIn.selectSupplier({
      signInStep: body.signInStep,
      stepBinding: readSignInStepBinding(request, body.signInStep),
      supplierId: body.supplierId,
      deviceName: body.deviceName ?? null,
      ip: ip ?? null,
    });
    clearSignInStepCookie(response, body.signInStep);
    return deliverSession(response, completed.issued, completed.response);
  }

  @ApiRoute(apiRoutes.startTotpSetup)
  startTotpSetup(
    @Body(new ZodValidationPipe(totpSetupBodySchema)) body: TotpSetupBody,
    @Req() request: Request,
  ): Promise<TotpSetupResponse> {
    return this.adminAuth.startSetup(
      body.signInStep,
      readSignInStepBinding(request, body.signInStep),
    );
  }

  @ApiRoute(apiRoutes.confirmTotpSetup)
  async confirmTotpSetup(
    @Body(new ZodValidationPipe(totpSetupConfirmBodySchema)) body: TotpSetupConfirmBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<TotpSetupCompletedResponse> {
    const completed = await this.adminAuth.confirmSetup({
      token: body.signInStep,
      stepBinding: readSignInStepBinding(request, body.signInStep),
      totpCode: body.totpCode,
      deviceName: body.deviceName ?? null,
      ip: ip ?? null,
    });
    clearSignInStepCookie(response, body.signInStep);
    return deliverSession(response, completed.issued, completed.response);
  }

  @ApiRoute(apiRoutes.verifyTotp)
  async verifyTotp(
    @Body(new ZodValidationPipe(totpVerifyBodySchema)) body: TotpVerifyBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<TotpVerifiedResponse> {
    const completed = await this.adminAuth.verify({
      token: body.signInStep,
      stepBinding: readSignInStepBinding(request, body.signInStep),
      factor:
        body.totpCode !== undefined
          ? { kind: "totp", code: body.totpCode }
          : { kind: "backup_code", code: body.backupCode ?? "" },
      deviceName: body.deviceName ?? null,
      ip: ip ?? null,
    });
    clearSignInStepCookie(response, body.signInStep);
    return deliverSession(response, completed.issued, completed.response);
  }
}
