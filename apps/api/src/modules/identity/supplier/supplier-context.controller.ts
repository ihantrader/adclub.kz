import { Body, Controller, Inject } from "@nestjs/common";
import {
  apiRoutes,
  switchSupplierBodySchema,
  type CurrentAccountResponse,
  type SupplierMembershipListResponse,
  type SwitchSupplierBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../../common/validation";
import { CurrentSession, SessionRoute } from "../session/session.guard";
import type { AuthenticatedSession } from "../session/session.service";
import { SupplierContextService } from "./supplier-context.service";

/**
 * Routes of the `supplier` context (a cabinet session of an active
 * employee) about the session itself. The company's card is served by the
 * supplier module (`GET /supplier/company`, TASK-016).
 */
@Controller()
export class SupplierContextController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierContextService) private readonly context: SupplierContextService) {}

  @SessionRoute(apiRoutes.listMySuppliers)
  listMySuppliers(
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierMembershipListResponse> {
    return this.context.listMine(session);
  }

  @SessionRoute(apiRoutes.switchSupplier)
  switchSupplier(
    @Body(new ZodValidationPipe(switchSupplierBodySchema)) body: SwitchSupplierBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CurrentAccountResponse> {
    return this.context.switchTo(session, body.supplierId);
  }
}
