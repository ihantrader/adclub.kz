import { Body, Controller, Inject, Ip, Param } from "@nestjs/common";
import {
  adminIdPathSchema,
  apiRoutes,
  regenerateBackupCodesBodySchema,
  type AdminIdPath,
  type AdministratorListResponse,
  type BackupCodesResponse,
  type RegenerateBackupCodesBody,
  type TotpResetResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../../common/validation";
import { CurrentSession, SessionRoute } from "../session/session.guard";
import type { AuthenticatedSession } from "../session/session.service";
import { AdminAuthService } from "./admin-auth.service";

/** The administrator a session of the `admin` context belongs to (the access rule set it). */
function adminOf(session: AuthenticatedSession): string {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return session.adminUserId;
}

/**
 * Routes of the `admin` context. There is deliberately no route to
 * appoint or remove an administrator (D-045): that is the operator
 * command only.
 */
@Controller()
export class AdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AdminAuthService) private readonly adminAuth: AdminAuthService) {}

  @SessionRoute(apiRoutes.listAdministrators)
  listAdministrators(
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdministratorListResponse> {
    return this.adminAuth.listAdministrators(adminOf(session));
  }

  @SessionRoute(apiRoutes.resetAdministratorTotp)
  resetAdministratorTotp(
    @Param(new ZodValidationPipe(adminIdPathSchema)) params: AdminIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<TotpResetResponse> {
    return this.adminAuth.resetByAdmin(adminOf(session), params.adminId);
  }

  @SessionRoute(apiRoutes.regenerateBackupCodes)
  regenerateBackupCodes(
    @Body(new ZodValidationPipe(regenerateBackupCodesBodySchema)) body: RegenerateBackupCodesBody,
    @CurrentSession() session: AuthenticatedSession,
    @Ip() ip: string | undefined,
  ): Promise<BackupCodesResponse> {
    return this.adminAuth.regenerateBackupCodes({
      adminId: adminOf(session),
      totpCode: body.totpCode,
      ip: ip ?? null,
    });
  }
}
