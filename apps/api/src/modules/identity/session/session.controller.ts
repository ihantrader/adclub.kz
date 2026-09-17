import { Body, Controller, Inject, Ip, Param, Req, Res } from "@nestjs/common";
import {
  apiRoutes,
  refreshSessionBodySchema,
  sessionIdPathSchema,
  type CurrentAccountResponse,
  type RefreshSessionBody,
  type SessionIdPath,
  type SessionListResponse,
  type SessionsEndedResponse,
  type SessionTokens,
} from "@adclub/contracts";
import type { Request, Response } from "express";
import { ApiRoute } from "../../../common/contract";
import { ApiException } from "../../../common/errors";
import { ZodValidationPipe } from "../../../common/validation";
import { APP_CONFIG, type AppConfig } from "../../../config";
import {
  clearRefreshCookie,
  cookieRefreshToken,
  isWebSessionKind,
  setRefreshCookie,
} from "./session-cookie";
import { CurrentSession, SessionRoute } from "./session.guard";
import {
  SessionService,
  type AuthenticatedSession,
  type EndSessionsResult,
} from "./session.service";

/** Refresh, current account, and the owner's list of sessions (ARCHITECTURE 8.2). */
@Controller()
export class SessionController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @ApiRoute(apiRoutes.refreshSession)
  async refreshSession(
    @Body(new ZodValidationPipe(refreshSessionBodySchema)) body: RefreshSessionBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Ip() ip: string | undefined,
  ): Promise<SessionTokens> {
    if (body.refreshToken !== undefined) {
      const issued = await this.sessions.refresh({
        token: body.refreshToken,
        transport: "body",
        ip: ip ?? null,
      });
      return issued.tokens;
    }

    // Web client: the token is in its HttpOnly cookie and goes back there.
    const cookie = cookieRefreshToken(request, this.config);
    try {
      const issued = await this.sessions.refresh({
        token: cookie.token,
        transport: cookie.kind,
        ip: ip ?? null,
      });
      setRefreshCookie(
        response,
        cookie.kind,
        issued.tokens.refreshToken,
        issued.sessionExpiresAt,
        new Date(),
      );
      const { refreshToken: _inCookie, ...tokens } = issued.tokens;
      return tokens;
    } catch (error) {
      if (
        error instanceof ApiException &&
        (error.code === "AUTH_REQUIRED" ||
          error.code === "SESSION_ENDED" ||
          error.code === "SUPPLIER_ACCESS_CLOSED")
      ) {
        // The cookie is useless now; don't keep sending it.
        clearRefreshCookie(response, cookie.kind);
      }
      throw error;
    }
  }

  @SessionRoute(apiRoutes.getCurrentAccount)
  getCurrentAccount(
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CurrentAccountResponse> {
    return this.sessions.getCurrent(session);
  }

  @SessionRoute(apiRoutes.listSessions)
  listSessions(@CurrentSession() session: AuthenticatedSession): Promise<SessionListResponse> {
    return this.sessions.list(session);
  }

  @SessionRoute(apiRoutes.endSession)
  async endSession(
    @Param(new ZodValidationPipe(sessionIdPathSchema)) params: SessionIdPath,
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionsEndedResponse> {
    return this.ended(response, await this.sessions.endOne(session, params.sessionId));
  }

  @SessionRoute(apiRoutes.endOtherSessions)
  async endOtherSessions(
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionsEndedResponse> {
    return this.ended(response, await this.sessions.endOthers(session));
  }

  @SessionRoute(apiRoutes.endAllSessions)
  async endAllSessions(
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionsEndedResponse> {
    return this.ended(response, await this.sessions.endAll(session));
  }

  @SessionRoute(apiRoutes.logout)
  async logout(
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionsEndedResponse> {
    return this.ended(response, await this.sessions.logout(session));
  }

  /** A web client whose own session ended also loses its refresh cookie. */
  private ended(response: Response, result: EndSessionsResult): SessionsEndedResponse {
    if (result.currentKind && isWebSessionKind(result.currentKind)) {
      clearRefreshCookie(response, result.currentKind);
    }
    return result.response;
  }
}
