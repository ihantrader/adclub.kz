import { Body, Controller, Inject, Ip, Res } from "@nestjs/common";
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
import type { Response } from "express";
import { ApiRoute } from "../../../common/contract";
import { ZodValidationPipe } from "../../../common/validation";
import { AdminAuthService } from "../admin/admin-auth.service";
import { SignInService } from "./sign-in.service";
import { deliverSession } from "./web-sign-in";

/**
 * The steps after the login code (ARCHITECTURE 8.1): the company choice of
 * the supplier cabinet and the admin second factor. Public routes — the
 * step token is the proof; the sessions they issue are web sessions.
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
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<SignInCompletedResponse> {
    const completed = await this.signIn.selectSupplier({
      signInStep: body.signInStep,
      supplierId: body.supplierId,
      deviceName: body.deviceName ?? null,
      ip: ip ?? null,
    });
    return deliverSession(response, completed.issued, completed.response);
  }

  @ApiRoute(apiRoutes.startTotpSetup)
  startTotpSetup(
    @Body(new ZodValidationPipe(totpSetupBodySchema)) body: TotpSetupBody,
  ): Promise<TotpSetupResponse> {
    return this.adminAuth.startSetup(body.signInStep);
  }

  @ApiRoute(apiRoutes.confirmTotpSetup)
  async confirmTotpSetup(
    @Body(new ZodValidationPipe(totpSetupConfirmBodySchema)) body: TotpSetupConfirmBody,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<TotpSetupCompletedResponse> {
    const completed = await this.adminAuth.confirmSetup({
      token: body.signInStep,
      totpCode: body.totpCode,
      deviceName: body.deviceName ?? null,
      ip: ip ?? null,
    });
    return deliverSession(response, completed.issued, completed.response);
  }

  @ApiRoute(apiRoutes.verifyTotp)
  async verifyTotp(
    @Body(new ZodValidationPipe(totpVerifyBodySchema)) body: TotpVerifyBody,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<TotpVerifiedResponse> {
    const completed = await this.adminAuth.verify({
      token: body.signInStep,
      factor:
        body.totpCode !== undefined
          ? { kind: "totp", code: body.totpCode }
          : { kind: "backup_code", code: body.backupCode ?? "" },
      deviceName: body.deviceName ?? null,
      ip: ip ?? null,
    });
    return deliverSession(response, completed.issued, completed.response);
  }
}
