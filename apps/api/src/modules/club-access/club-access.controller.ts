import { Body, Controller, Inject, Query } from "@nestjs/common";
import {
  apiRoutes,
  clubAccessGrantQuerySchema,
  grantClubAccessBodySchema,
  revokeClubAccessBodySchema,
  type ClubAccessGrantPage,
  type ClubAccessGrantQuery,
  type ClubAccessGrantResponse,
  type GrantClubAccessBody,
  type RevokeClubAccessBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { ClubAccessGrants, type ClubAccessChanger } from "./club-access-grants.service";

function adminChanger(session: AuthenticatedSession): ClubAccessChanger {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { role: "admin", adminId: session.adminUserId, accountId: session.accountId };
}

/** Club access given by hand in the admin panel (context `admin`; D-059, TASK-020). */
@Controller()
export class ClubAccessAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(ClubAccessGrants) private readonly grants: ClubAccessGrants) {}

  @SessionRoute(apiRoutes.listClubAccessGrants)
  list(
    @Query(new ZodValidationPipe(clubAccessGrantQuerySchema)) query: ClubAccessGrantQuery,
  ): Promise<ClubAccessGrantPage> {
    return this.grants.page(query);
  }

  @SessionRoute(apiRoutes.grantClubAccess)
  grant(
    @Body(new ZodValidationPipe(grantClubAccessBodySchema)) body: GrantClubAccessBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ClubAccessGrantResponse> {
    return this.grants.grant(
      { phone: body.phone, validUntil: new Date(body.validUntil), reason: body.reason },
      adminChanger(session),
    );
  }

  @SessionRoute(apiRoutes.revokeClubAccess)
  revoke(
    @Body(new ZodValidationPipe(revokeClubAccessBodySchema)) body: RevokeClubAccessBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ClubAccessGrantResponse> {
    return this.grants.revoke(body, adminChanger(session));
  }
}
