import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiRouteDefinition } from "@adclub/contracts";
import type { Request } from "express";
import { API_ROUTE_METADATA, ApiRoute, SessionAccessGuard } from "../../../common/contract";
import { SessionService, type AuthenticatedSession } from "./session.service";

const authenticatedSessions = new WeakMap<Request, AuthenticatedSession>();

/**
 * Lets a request through only with a valid access token of an active
 * session whose context the route serves (`SessionService.authenticate`
 * applies the single access rule to the route's `contexts` from the
 * contract), and remembers who it is for `@CurrentSession()`. Bound per
 * route by `SessionRoute`, so it runs after the global client version
 * guard. Nothing in the request but the access token matters.
 */
@Injectable()
@SessionAccessGuard()
export class SessionGuard implements CanActivate {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.get<ApiRouteDefinition | undefined>(
      API_ROUTE_METADATA,
      context.getHandler(),
    );
    const contexts = route?.contexts ?? [];
    if (contexts.length === 0) {
      // `ApiRoute` refuses such a binding; never serve one if it happens.
      throw new Error("A session route without contexts reached the session guard");
    }
    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.sessions.authenticate(
      request.headers.authorization,
      request.ip ?? null,
      contexts,
    );
    authenticatedSessions.set(request, session);
    return true;
  }
}

/** A contract route with `auth: "session"`, protected by `SessionGuard`. */
export function SessionRoute(route: ApiRouteDefinition): MethodDecorator {
  if (route.auth !== "session") {
    throw new Error(`${route.operationId} is not a session route in the contract`);
  }
  return ApiRoute(route, { guards: [SessionGuard] });
}

/** The session `SessionGuard` authenticated for this request. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedSession => {
    const session = authenticatedSessions.get(context.switchToHttp().getRequest<Request>());
    if (!session) {
      // A handler asked for the session on a route without SessionRoute.
      throw new Error("No authenticated session: the route is not a SessionRoute");
    }
    return session;
  },
);
