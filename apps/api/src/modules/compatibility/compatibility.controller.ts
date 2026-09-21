import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  adminCompatibilityProposalQuerySchema,
  apiRoutes,
  approveCompatibilityProposalBodySchema,
  archiveCompatibilityRecordBodySchema,
  compatibilityCheckBodySchema,
  compatibilityItemPathSchema,
  compatibilityProposalPathSchema,
  compatibilityRecordPathSchema,
  copyCompatibilityBodySchema,
  createCompatibilityProposalBodySchema,
  createCompatibilityRecordBodySchema,
  itemCompatibilityQuerySchema,
  rejectCompatibilityProposalBodySchema,
  supplierCompatibilityProposalQuerySchema,
  updateCompatibilityRecordBodySchema,
  type AdminCompatibilityProposalPage,
  type AdminCompatibilityProposalQuery,
  type AdminCompatibilityProposalResponse,
  type AdminCompatibilityRecordResponse,
  type AdminItemCompatibilityResponse,
  type ApproveCompatibilityProposalBody,
  type ArchiveCompatibilityRecordBody,
  type CompatibilityCheckBody,
  type CompatibilityCheckResponse,
  type CompatibilityItemPath,
  type CompatibilityProposalPath,
  type CompatibilityRecordPath,
  type CopyCompatibilityBody,
  type CopyCompatibilityResponse,
  type CreateCompatibilityProposalBody,
  type CreateCompatibilityRecordBody,
  type ItemCompatibilityQuery,
  type RejectCompatibilityProposalBody,
  type SupplierCompatibilityProposalPage,
  type SupplierCompatibilityProposalQuery,
  type SupplierCompatibilityProposalResponse,
  type UpdateCompatibilityRecordBody,
} from "@adclub/contracts";
import { ApiRoute } from "../../common/contract";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { CompatibilityEvaluator } from "./compatibility-evaluator";
import {
  CompatibilityProposalsService,
  type SupplierActor,
} from "./compatibility-proposals.service";
import { CompatibilityRecordsService } from "./compatibility-records.service";

function adminActor(session: AuthenticatedSession) {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { role: "admin" as const, adminId: session.adminUserId, accountId: session.accountId };
}

function supplierActor(session: AuthenticatedSession): SupplierActor {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A cabinet route reached without a company");
  }
  return {
    role: "supplier",
    accountId: session.accountId,
    supplierId: session.supplierId,
    memberId: session.supplierMemberId,
  };
}

/**
 * Compatibility of items (TASK-015; ARCHITECTURE 4.25): the records kept by
 * the administrator and the moderation queue (context `admin`; A-CAT-05,
 * A-MOD), proposals of the supplier's own company (context `supplier`),
 * and the check for a car, open to guests and every session. The screens
 * are TASK-035 and EPIC-11.
 */
@Controller()
export class CompatibilityController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(CompatibilityRecordsService) private readonly records: CompatibilityRecordsService,
    @Inject(CompatibilityProposalsService)
    private readonly proposals: CompatibilityProposalsService,
    @Inject(CompatibilityEvaluator) private readonly evaluator: CompatibilityEvaluator,
  ) {}

  // ----------------------------------------------------------------- admin

  @SessionRoute(apiRoutes.getItemCompatibility)
  card(
    @Param(new ZodValidationPipe(compatibilityItemPathSchema)) params: CompatibilityItemPath,
    @Query(new ZodValidationPipe(itemCompatibilityQuerySchema)) query: ItemCompatibilityQuery,
  ): Promise<AdminItemCompatibilityResponse> {
    return this.records.card(params.itemId, query.includeArchived === "true");
  }

  @SessionRoute(apiRoutes.createCompatibilityRecord)
  async create(
    @Param(new ZodValidationPipe(compatibilityItemPathSchema)) params: CompatibilityItemPath,
    @Body(new ZodValidationPipe(createCompatibilityRecordBodySchema))
    body: CreateCompatibilityRecordBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCompatibilityRecordResponse> {
    return { record: await this.records.create(params.itemId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.copyCompatibility)
  copy(
    @Param(new ZodValidationPipe(compatibilityItemPathSchema)) params: CompatibilityItemPath,
    @Body(new ZodValidationPipe(copyCompatibilityBodySchema)) body: CopyCompatibilityBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CopyCompatibilityResponse> {
    return this.records.copyFromAnalog(params.itemId, body.fromItemId, adminActor(session));
  }

  @SessionRoute(apiRoutes.updateCompatibilityRecord)
  async update(
    @Param(new ZodValidationPipe(compatibilityRecordPathSchema)) params: CompatibilityRecordPath,
    @Body(new ZodValidationPipe(updateCompatibilityRecordBodySchema))
    body: UpdateCompatibilityRecordBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCompatibilityRecordResponse> {
    return { record: await this.records.update(params.recordId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.archiveCompatibilityRecord)
  async archive(
    @Param(new ZodValidationPipe(compatibilityRecordPathSchema)) params: CompatibilityRecordPath,
    @Body(new ZodValidationPipe(archiveCompatibilityRecordBodySchema))
    body: ArchiveCompatibilityRecordBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCompatibilityRecordResponse> {
    return {
      record: await this.records.archive(
        params.recordId,
        body.expectedVersion,
        adminActor(session),
      ),
    };
  }

  @SessionRoute(apiRoutes.listCompatibilityProposals)
  queue(
    @Query(new ZodValidationPipe(adminCompatibilityProposalQuerySchema))
    query: AdminCompatibilityProposalQuery,
  ): Promise<AdminCompatibilityProposalPage> {
    return this.proposals.queue(query);
  }

  @SessionRoute(apiRoutes.approveCompatibilityProposal)
  approve(
    @Param(new ZodValidationPipe(compatibilityProposalPathSchema))
    params: CompatibilityProposalPath,
    @Body(new ZodValidationPipe(approveCompatibilityProposalBodySchema))
    body: ApproveCompatibilityProposalBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCompatibilityProposalResponse> {
    return this.proposals.approve(params.proposalId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.rejectCompatibilityProposal)
  reject(
    @Param(new ZodValidationPipe(compatibilityProposalPathSchema))
    params: CompatibilityProposalPath,
    @Body(new ZodValidationPipe(rejectCompatibilityProposalBodySchema))
    body: RejectCompatibilityProposalBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminCompatibilityProposalResponse> {
    return this.proposals.reject(params.proposalId, body.reason, adminActor(session));
  }

  // -------------------------------------------------------------- supplier

  @SessionRoute(apiRoutes.createCompatibilityProposal)
  async propose(
    @Param(new ZodValidationPipe(compatibilityItemPathSchema)) params: CompatibilityItemPath,
    @Body(new ZodValidationPipe(createCompatibilityProposalBodySchema))
    body: CreateCompatibilityProposalBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCompatibilityProposalResponse> {
    return {
      proposal: await this.proposals.propose(params.itemId, body, supplierActor(session)),
    };
  }

  @SessionRoute(apiRoutes.listSupplierCompatibilityProposals)
  own(
    @Query(new ZodValidationPipe(supplierCompatibilityProposalQuerySchema))
    query: SupplierCompatibilityProposalQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCompatibilityProposalPage> {
    return this.proposals.supplierPage(supplierActor(session).supplierId, query);
  }

  @SessionRoute(apiRoutes.getSupplierCompatibilityProposal)
  async ownOne(
    @Param(new ZodValidationPipe(compatibilityProposalPathSchema))
    params: CompatibilityProposalPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCompatibilityProposalResponse> {
    return {
      proposal: await this.proposals.supplierProposal(
        supplierActor(session).supplierId,
        params.proposalId,
      ),
    };
  }

  // ---------------------------------------------------------------- client

  /** A read, though a POST: the car and the items travel in the body (200, not cached). */
  @ApiRoute(apiRoutes.checkCompatibility)
  check(
    @Body(new ZodValidationPipe(compatibilityCheckBodySchema)) body: CompatibilityCheckBody,
  ): Promise<CompatibilityCheckResponse> {
    return this.evaluator.check(body);
  }
}
