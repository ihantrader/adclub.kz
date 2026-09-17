import type { SessionTokens } from "@adclub/contracts";
import type { Response } from "express";
import { isWebSessionKind, setRefreshCookie } from "./session-cookie";
import type { IssuedSession } from "./session.service";

/**
 * The body of a finished sign-in. A web session's refresh token goes to
 * its HttpOnly cookie and never into the body; a mobile one stays there.
 */
export function deliverSession<Body extends { session: SessionTokens }>(
  response: Response,
  issued: IssuedSession,
  body: Body,
): Body {
  const kind = issued.tokens.kind;
  if (!isWebSessionKind(kind)) {
    return body;
  }
  setRefreshCookie(response, kind, issued.tokens.refreshToken, issued.sessionExpiresAt, new Date());
  const { refreshToken: _inCookie, ...tokens } = body.session;
  return { ...body, session: tokens };
}
