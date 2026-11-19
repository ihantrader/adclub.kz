import { Body, Controller, Get, Inject, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  adminSearchQuerySchema,
  adminUserListQuerySchema,
  adminUserPathSchema,
  adminUserSessionPathSchema,
  adminUserSessionListQuerySchema,
  apiRoutes,
  createAdminUserDataExportBodySchema,
  revealPhoneBodySchema,
  type AdminUserDataExportLink,
  type CreateAdminUserDataExportBody,
  type AdminSearchQuery,
  type AdminSearchResponse,
  type AdminUserGarageResponse,
  type AdminUserListQuery,
  type AdminUserPage,
  type AdminUserPath,
  type AdminUserResponse,
  type AdminUserSessionListResponse,
  type AdminUserSessionListQuery,
  type AdminUserSessionPath,
  type AdminUserSessionsEndedResponse,
  type RevealPhoneBody,
  type RevealPhoneResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { AccountDataExports, ACCOUNT_EXPORT_DOWNLOAD_PATH } from "./account-data-exports.service";
import { AdminSearch } from "./admin-search.service";
import { AdminUsersService, type AdminActor } from "./admin-users.service";
import { PhoneReveals } from "./phone-reveals.service";

function adminActor(session: AuthenticatedSession): AdminActor {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { accountId: session.accountId, adminId: session.adminUserId };
}

/**
 * Users of the app, «Показать номер» and the header's search in the admin
 * panel (context `admin`; TASK-036.B; SCREENS A-USR-01…03, A-SEARCH, 7.0).
 */
@Controller()
export class AdminUsersController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AdminUsersService) private readonly users: AdminUsersService,
    @Inject(PhoneReveals) private readonly reveals: PhoneReveals,
    @Inject(AdminSearch) private readonly searcher: AdminSearch,
    @Inject(AccountDataExports) private readonly exports: AccountDataExports,
  ) {}

  @SessionRoute(apiRoutes.listAdminUsers)
  list(
    @Query(new ZodValidationPipe(adminUserListQuerySchema)) query: AdminUserListQuery,
  ): Promise<AdminUserPage> {
    return this.users.list(query);
  }

  @SessionRoute(apiRoutes.getAdminUser)
  async one(
    @Param(new ZodValidationPipe(adminUserPathSchema)) params: AdminUserPath,
  ): Promise<AdminUserResponse> {
    return { user: await this.users.card(params.accountId) };
  }

  @SessionRoute(apiRoutes.getAdminUserGarage)
  garage(
    @Param(new ZodValidationPipe(adminUserPathSchema)) params: AdminUserPath,
  ): Promise<AdminUserGarageResponse> {
    return this.users.garageOf(params.accountId);
  }

  @SessionRoute(apiRoutes.listAdminUserSessions)
  sessions(
    @Param(new ZodValidationPipe(adminUserPathSchema)) params: AdminUserPath,
    @Query(new ZodValidationPipe(adminUserSessionListQuerySchema)) query: AdminUserSessionListQuery,
  ): Promise<AdminUserSessionListResponse> {
    return this.users.sessionsOf(params.accountId, query);
  }

  @SessionRoute(apiRoutes.endAdminUserSession)
  async endOne(
    @Param(new ZodValidationPipe(adminUserSessionPathSchema)) params: AdminUserSessionPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminUserSessionsEndedResponse> {
    return {
      ended: await this.users.endSessions(params.accountId, params.sessionId, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.endAdminUserSessions)
  async endAll(
    @Param(new ZodValidationPipe(adminUserPathSchema)) params: AdminUserPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminUserSessionsEndedResponse> {
    return { ended: await this.users.endSessions(params.accountId, null, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.createAdminUserDataExport)
  dataExport(
    @Param(new ZodValidationPipe(adminUserPathSchema)) params: AdminUserPath,
    @Body(new ZodValidationPipe(createAdminUserDataExportBodySchema))
    body: CreateAdminUserDataExportBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminUserDataExportLink> {
    return this.exports.link(adminActor(session), params.accountId, body);
  }

  @RateLimitedRoute(apiRoutes.revealPhone)
  reveal(
    @Body(new ZodValidationPipe(revealPhoneBodySchema)) body: RevealPhoneBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<RevealPhoneResponse> {
    return this.reveals.reveal(body.subject, body.id, adminActor(session));
  }

  @RateLimitedRoute(apiRoutes.searchAdmin)
  search(
    @Query(new ZodValidationPipe(adminSearchQuerySchema)) query: AdminSearchQuery,
  ): Promise<AdminSearchResponse> {
    return this.searcher.search(query.q);
  }
}

/**
 * The download of «Выгрузить данные…» (TASK-072). Outside the client
 * contract, like «Скачать мой прайс»: the answer is a file the browser opens
 * as a plain link, so the session's access token is not what lets it in —
 * the one-time token of the link is (the token is in the query, which the
 * access log never writes).
 */
@Controller()
export class AccountDataExportController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AccountDataExports) private readonly exports: AccountDataExports) {}

  @Get(ACCOUNT_EXPORT_DOWNLOAD_PATH)
  async download(
    @Query("token") token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.exports.take(typeof token === "string" ? token : undefined);
    response.status(200);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(file.body);
  }
}
