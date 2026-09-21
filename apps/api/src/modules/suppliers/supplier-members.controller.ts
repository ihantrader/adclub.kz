import { Body, Controller, Inject, Param } from "@nestjs/common";
import {
  addSupplierMemberBodySchema,
  apiRoutes,
  endSupplierSessionsBodySchema,
  restoreSupplierMemberBodySchema,
  supplierAdminPathSchema,
  supplierMemberIdPathSchema,
  supplierMemberPathSchema,
  supplierSessionPathSchema,
  updateSupplierMemberBodySchema,
  type AddSupplierMemberBody,
  type AdminSupplierMemberAddedResponse,
  type AdminSupplierMemberListResponse,
  type AdminSupplierMemberResponse,
  type AdminSupplierSessionListResponse,
  type EndSupplierSessionsBody,
  type RestoreSupplierMemberBody,
  type SupplierAdminPath,
  type SupplierMemberAddedResponse,
  type SupplierMemberIdPath,
  type SupplierMemberListResponse,
  type SupplierMemberPath,
  type SupplierMemberRemovedResponse,
  type SupplierMemberResponse,
  type SupplierSessionPath,
  type SupplierSessionsEndedResponse,
  type UpdateSupplierMemberBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { supplierSelfActor } from "./supplier-common";
import { SupplierMembersService } from "./supplier-members.service";

/**
 * Employees in the cabinet (context `supplier`; SCREENS S-TEAM-01,
 * S-TEAM-02). The company is the session's; an employee of another
 * company answers like a missing one (404).
 */
@Controller()
export class SupplierMembersCabinetController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierMembersService) private readonly members: SupplierMembersService) {}

  @SessionRoute(apiRoutes.listSupplierMembers)
  list(@CurrentSession() session: AuthenticatedSession): Promise<SupplierMemberListResponse> {
    return this.members.list(supplierSelfActor(session));
  }

  @SessionRoute(apiRoutes.addSupplierMember)
  add(
    @Body(new ZodValidationPipe(addSupplierMemberBodySchema)) body: AddSupplierMemberBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierMemberAddedResponse> {
    return this.members.addByMember(supplierSelfActor(session), body);
  }

  @SessionRoute(apiRoutes.updateSupplierMember)
  update(
    @Param(new ZodValidationPipe(supplierMemberIdPathSchema)) params: SupplierMemberIdPath,
    @Body(new ZodValidationPipe(updateSupplierMemberBodySchema)) body: UpdateSupplierMemberBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierMemberResponse> {
    return this.members.update(supplierSelfActor(session), params.memberId, body);
  }

  @SessionRoute(apiRoutes.removeSupplierMember)
  remove(
    @Param(new ZodValidationPipe(supplierMemberIdPathSchema)) params: SupplierMemberIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierMemberRemovedResponse> {
    return this.members.remove(supplierSelfActor(session), params.memberId);
  }

  @SessionRoute(apiRoutes.getSupplierMe)
  me(@CurrentSession() session: AuthenticatedSession): Promise<SupplierMemberResponse> {
    const actor = supplierSelfActor(session);
    return this.members.one(actor, actor.memberId);
  }

  @SessionRoute(apiRoutes.updateSupplierMe)
  updateMe(
    @Body(new ZodValidationPipe(updateSupplierMemberBodySchema)) body: UpdateSupplierMemberBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierMemberResponse> {
    const actor = supplierSelfActor(session);
    return this.members.update(actor, actor.memberId, body);
  }
}

/** Employees and their sessions in the admin panel (context `admin`; SCREENS A-SUP-03). */
@Controller()
export class SupplierMembersAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierMembersService) private readonly members: SupplierMembersService) {}

  @SessionRoute(apiRoutes.listAdminSupplierMembers)
  list(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
  ): Promise<AdminSupplierMemberListResponse> {
    return this.members.adminList(params.supplierId);
  }

  @SessionRoute(apiRoutes.addAdminSupplierMember)
  add(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(addSupplierMemberBodySchema)) body: AddSupplierMemberBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierMemberAddedResponse> {
    return this.members.addByAdmin(params.supplierId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.restoreSupplierMember)
  restore(
    @Param(new ZodValidationPipe(supplierMemberPathSchema)) params: SupplierMemberPath,
    @Body(new ZodValidationPipe(restoreSupplierMemberBodySchema)) body: RestoreSupplierMemberBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierMemberResponse> {
    return this.members.restore(
      params.supplierId,
      params.memberId,
      body.reason,
      adminActor(session),
    );
  }

  @SessionRoute(apiRoutes.setSupplierContactPerson)
  setContactPerson(
    @Param(new ZodValidationPipe(supplierMemberPathSchema)) params: SupplierMemberPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierMemberResponse> {
    return this.members.setContactPerson(params.supplierId, params.memberId, adminActor(session));
  }

  @SessionRoute(apiRoutes.listSupplierSessions)
  async sessions(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
  ): Promise<AdminSupplierSessionListResponse> {
    return { sessions: await this.members.listSessions(params.supplierId) };
  }

  @SessionRoute(apiRoutes.endSupplierSession)
  async endSession(
    @Param(new ZodValidationPipe(supplierSessionPathSchema)) params: SupplierSessionPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierSessionsEndedResponse> {
    return {
      ended: await this.members.endSessions(
        params.supplierId,
        { sessionId: params.sessionId },
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.endSupplierSessions)
  async endSessions(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Body(new ZodValidationPipe(endSupplierSessionsBodySchema)) body: EndSupplierSessionsBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierSessionsEndedResponse> {
    return {
      ended: await this.members.endSessions(
        params.supplierId,
        body.memberId ? { memberId: body.memberId } : {},
        adminActor(session),
      ),
    };
  }
}
