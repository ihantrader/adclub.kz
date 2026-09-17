import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  apiRoutes,
  supplierIdPathSchema,
  switchSupplierBodySchema,
  type CurrentAccountResponse,
  type SupplierCompanyResponse,
  type SupplierIdPath,
  type SupplierMembershipListResponse,
  type SwitchSupplierBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../../common/validation";
import { CurrentSession, SessionRoute } from "../session/session.guard";
import type { AuthenticatedSession } from "../session/session.service";
import { SupplierContextService } from "./supplier-context.service";

/** Routes of the `supplier` context (a cabinet session of an active employee). */
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

  @SessionRoute(apiRoutes.getSupplierCompany)
  getSupplierCompany(
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCompanyResponse> {
    // The access rule guarantees a supplier context has its company.
    return this.context.company(session, session.supplierId ?? "");
  }

  @SessionRoute(apiRoutes.getSupplierCompanyById)
  getSupplierCompanyById(
    @Param(new ZodValidationPipe(supplierIdPathSchema)) params: SupplierIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCompanyResponse> {
    return this.context.company(session, params.supplierId);
  }
}
