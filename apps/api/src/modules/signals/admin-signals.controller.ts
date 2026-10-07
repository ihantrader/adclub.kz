import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  acknowledgeAdminSignalBodySchema,
  adminSignalIdPathSchema,
  adminSignalListQuerySchema,
  apiRoutes,
  closeAdminSignalBodySchema,
  type AcknowledgeAdminSignalBody,
  type AdminSignalIdPath,
  type AdminSignalListQuery,
  type AdminSignalPage,
  type AdminSignalResponse,
  type CloseAdminSignalBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { AdminSignals, type SignalActor } from "./admin-signals.service";

/** The administrator a session of the `admin` context belongs to (the access rule set it). */
function actorOf(session: AuthenticatedSession): SignalActor {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { adminId: session.adminUserId, accountId: session.accountId };
}

/** Signals for a person to look at (context `admin`; SCREENS A-SIG). */
@Controller()
export class AdminSignalsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AdminSignals) private readonly signals: AdminSignals) {}

  @SessionRoute(apiRoutes.listAdminSignals)
  list(
    @Query(new ZodValidationPipe(adminSignalListQuerySchema)) query: AdminSignalListQuery,
  ): Promise<AdminSignalPage> {
    return this.signals.page(query);
  }

  @SessionRoute(apiRoutes.acknowledgeAdminSignal)
  async acknowledge(
    @Param(new ZodValidationPipe(adminSignalIdPathSchema)) params: AdminSignalIdPath,
    @Body(new ZodValidationPipe(acknowledgeAdminSignalBodySchema)) body: AcknowledgeAdminSignalBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSignalResponse> {
    return {
      signal: await this.signals.acknowledge(
        params.signalId,
        body.expectedVersion,
        actorOf(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.closeAdminSignal)
  async close(
    @Param(new ZodValidationPipe(adminSignalIdPathSchema)) params: AdminSignalIdPath,
    @Body(new ZodValidationPipe(closeAdminSignalBodySchema)) body: CloseAdminSignalBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSignalResponse> {
    return {
      signal: await this.signals.closeByAdmin(
        params.signalId,
        body.expectedVersion,
        body.comment,
        actorOf(session),
      ),
    };
  }
}
