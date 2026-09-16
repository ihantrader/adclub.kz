import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiRouteDefinition } from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Request } from "express";
import { getRequestClient } from "../common/client";
import { API_ROUTE_METADATA } from "../common/contract";
import { ClientPolicyService } from "./client-policy.service";

/**
 * Global guard (ARCHITECTURE 7.4): a known client below its platform's
 * minimum version gets `CLIENT_UPDATE_REQUIRED` on every route except the
 * ones the contract marks `exempt` (health, the client policy). Routes
 * without contract metadata — including the unmatched-route 404 — are
 * enforced: an outdated client should learn it must update, whatever it
 * called. Clients without a valid `X-Client` are never rejected here.
 */
@Injectable()
export class ClientVersionGuard implements CanActivate {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ClientPolicyService) private readonly policy: ClientPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }

    const route = this.reflector.get<ApiRouteDefinition | undefined>(
      API_ROUTE_METADATA,
      context.getHandler(),
    );
    if (route?.clientVersionCheck === "exempt") {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const requestClient = getRequestClient(request);
    if (requestClient.kind !== "known") {
      return true;
    }

    await this.policy.assertSupported(
      requestClient.client,
      pickLanguage(request.headers["accept-language"]),
    );
    return true;
  }
}
