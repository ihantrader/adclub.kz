import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  createSupplierBodySchema,
  setSupplierBlockBodySchema,
  setSupplierPauseBodySchema,
  setSupplierScheduleBodySchema,
  setSupplierVerificationBodySchema,
  supplierAdminPathSchema,
  supplierIdPathSchema,
  supplierListQuerySchema,
  supplierMemberPathSchema,
  updateSupplierBodySchema,
  type AdminSupplierPage,
  type AdminSupplierResponse,
  type CreateSupplierBody,
  type SetSupplierBlockBody,
  type SetSupplierPauseBody,
  type SetSupplierScheduleBody,
  type SetSupplierVerificationBody,
  type SupplierAdminPath,
  type SupplierCardResponse,
  type SupplierCompanyResponse,
  type SupplierIdPath,
  type SupplierInvitationResponse,
  type SupplierListQuery,
  type SupplierMemberPath,
  type SupplierOnboardedResponse,
  type UpdateSupplierBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { notFound, supplierSelfActor } from "./supplier-common";
import { SupplierInvitations } from "./supplier-invitations";
import { SupplierLeadsService } from "./supplier-leads.service";
import { SuppliersService } from "./suppliers.service";

/** Suppliers in the admin panel (context `admin`; SCREENS A-SUP-02…04). The screens are EPIC-12. */
@Controller()
export class SuppliersAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SuppliersService) private readonly suppliers: SuppliersService,
    @Inject(SupplierLeadsService) private readonly leads: SupplierLeadsService,
    @Inject(SupplierInvitations) private readonly invitations: SupplierInvitations,
  ) {}

  @SessionRoute(apiRoutes.listSuppliers)
  list(
    @Query(new ZodValidationPipe(supplierListQuerySchema)) query: SupplierListQuery,
  ): Promise<AdminSupplierPage> {
    return this.suppliers.list(query);
  }

  @SessionRoute(apiRoutes.createSupplier)
  create(
    @Body(new ZodValidationPipe(createSupplierBodySchema)) body: CreateSupplierBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOnboardedResponse> {
    return this.leads.createSupplier(body, adminActor(session));
  }

  @SessionRoute(apiRoutes.getAdminSupplier)
  async get(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
  ): Promise<AdminSupplierResponse> {
    return { supplier: await this.suppliers.adminCard(params.supplierId) };
  }

  @SessionRoute(apiRoutes.updateSupplier)
  async update(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(updateSupplierBodySchema)) body: UpdateSupplierBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierResponse> {
    return {
      supplier: await this.suppliers.update(params.supplierId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.setAdminSupplierSchedule)
  async setSchedule(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(setSupplierScheduleBodySchema)) body: SetSupplierScheduleBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierResponse> {
    await this.suppliers.setSchedule(params.supplierId, body, adminActor(session));
    return { supplier: await this.suppliers.adminCard(params.supplierId) };
  }

  @SessionRoute(apiRoutes.setSupplierVerification)
  async setVerification(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(setSupplierVerificationBodySchema))
    body: SetSupplierVerificationBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierResponse> {
    return {
      supplier: await this.suppliers.setVerification(params.supplierId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.setSupplierPause)
  async setPause(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(setSupplierPauseBodySchema)) body: SetSupplierPauseBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierResponse> {
    return {
      supplier: await this.suppliers.setPause(params.supplierId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.setSupplierBlock)
  async setBlock(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(setSupplierBlockBodySchema)) body: SetSupplierBlockBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierResponse> {
    return {
      supplier: await this.suppliers.setBlock(params.supplierId, body, adminActor(session)),
    };
  }

  @SessionRoute(apiRoutes.resendSupplierInvitation)
  async resendInvitation(
    @Param(new ZodValidationPipe(supplierMemberPathSchema)) params: SupplierMemberPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierInvitationResponse> {
    return {
      invitation: await this.invitations.resend(
        params.supplierId,
        params.memberId,
        adminActor(session),
      ),
    };
  }
}

/**
 * The cabinet's own company (context `supplier`): its card, and its
 * schedule — the only part the supplier changes itself; the name, the
 * БИН, the address and the rest belong to the administrator (TASK-016
 * requirement 5). Any other company answers exactly like a missing one
 * (ARCHITECTURE 4.8 I70).
 */
@Controller()
export class SupplierCabinetController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SuppliersService) private readonly suppliers: SuppliersService) {}

  @SessionRoute(apiRoutes.getSupplierCompany)
  getCompany(@CurrentSession() session: AuthenticatedSession): Promise<SupplierCompanyResponse> {
    // The access rule guarantees a supplier context has its company.
    return this.company(session.supplierId ?? "");
  }

  @SessionRoute(apiRoutes.getSupplierCompanyById)
  getCompanyById(
    @Param(new ZodValidationPipe(supplierIdPathSchema)) params: SupplierIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCompanyResponse> {
    if (params.supplierId !== session.supplierId) {
      return Promise.reject(notFound("company"));
    }
    return this.company(params.supplierId);
  }

  @SessionRoute(apiRoutes.setSupplierSchedule)
  async setSchedule(
    @Body(new ZodValidationPipe(setSupplierScheduleBodySchema)) body: SetSupplierScheduleBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCardResponse> {
    const actor = supplierSelfActor(session);
    await this.suppliers.setSchedule(actor.supplierId, body, actor);
    return { company: (await this.suppliers.ownCard(actor.supplierId)).card };
  }

  private async company(supplierId: string): Promise<SupplierCompanyResponse> {
    const { card, cityName } = await this.suppliers.ownCard(supplierId);
    return {
      supplier: { id: card.id, name: card.name, city: cityName, status: card.state },
      company: card,
    };
  }
}
