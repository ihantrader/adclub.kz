import { Body, Controller, Headers, Inject, Param, Query } from "@nestjs/common";
import {
  addSupplierLeadNoteBodySchema,
  apiRoutes,
  createSupplierLeadBodySchema,
  onboardSupplierLeadBodySchema,
  setSupplierLeadStatusBodySchema,
  submitSupplierLeadBodySchema,
  supplierLeadIdPathSchema,
  supplierLeadListQuerySchema,
  updateSupplierLeadBodySchema,
  type AddSupplierLeadNoteBody,
  type AdminSupplierLeadPage,
  type AdminSupplierLeadResponse,
  type CreateSupplierLeadBody,
  type OnboardSupplierLeadBody,
  type SetSupplierLeadStatusBody,
  type SubmitSupplierLeadBody,
  type SupplierLeadIdPath,
  type SupplierLeadListQuery,
  type SupplierLeadReceivedResponse,
  type SupplierOnboardedResponse,
  type UpdateSupplierLeadBody,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { SupplierLeadForm } from "./supplier-lead-form.service";
import { SupplierLeadsService } from "./supplier-leads.service";

/** The public connection request form (S-PUB-01) and the funnel (A-SUP-01, A-SUP-04). */
@Controller()
export class SupplierLeadsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SupplierLeadForm) private readonly form: SupplierLeadForm,
    @Inject(SupplierLeadsService) private readonly leads: SupplierLeadsService,
  ) {}

  /** Open without signing in; limited per client address by the route's guard. */
  @RateLimitedRoute(apiRoutes.submitSupplierLead)
  submit(
    @Body(new ZodValidationPipe(submitSupplierLeadBodySchema)) body: SubmitSupplierLeadBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<SupplierLeadReceivedResponse> {
    return this.form.submit(body, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.listSupplierLeads)
  list(
    @Query(new ZodValidationPipe(supplierLeadListQuerySchema)) query: SupplierLeadListQuery,
  ): Promise<AdminSupplierLeadPage> {
    return this.leads.list(query);
  }

  @SessionRoute(apiRoutes.createSupplierLead)
  async create(
    @Body(new ZodValidationPipe(createSupplierLeadBodySchema)) body: CreateSupplierLeadBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierLeadResponse> {
    return { lead: await this.leads.create(body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.getSupplierLead)
  async get(
    @Param(new ZodValidationPipe(supplierLeadIdPathSchema)) params: SupplierLeadIdPath,
  ): Promise<AdminSupplierLeadResponse> {
    return { lead: await this.leads.card(params.leadId) };
  }

  @SessionRoute(apiRoutes.updateSupplierLead)
  async update(
    @Param(new ZodValidationPipe(supplierLeadIdPathSchema)) params: SupplierLeadIdPath,
    @Body(new ZodValidationPipe(updateSupplierLeadBodySchema)) body: UpdateSupplierLeadBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierLeadResponse> {
    return { lead: await this.leads.update(params.leadId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.setSupplierLeadStatus)
  async setStatus(
    @Param(new ZodValidationPipe(supplierLeadIdPathSchema)) params: SupplierLeadIdPath,
    @Body(new ZodValidationPipe(setSupplierLeadStatusBodySchema)) body: SetSupplierLeadStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierLeadResponse> {
    return { lead: await this.leads.setStatus(params.leadId, body, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.addSupplierLeadNote)
  async addNote(
    @Param(new ZodValidationPipe(supplierLeadIdPathSchema)) params: SupplierLeadIdPath,
    @Body(new ZodValidationPipe(addSupplierLeadNoteBodySchema)) body: AddSupplierLeadNoteBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminSupplierLeadResponse> {
    return { lead: await this.leads.addNote(params.leadId, body.text, adminActor(session)) };
  }

  @SessionRoute(apiRoutes.onboardSupplierLead)
  onboard(
    @Param(new ZodValidationPipe(supplierLeadIdPathSchema)) params: SupplierLeadIdPath,
    @Body(new ZodValidationPipe(onboardSupplierLeadBodySchema)) body: OnboardSupplierLeadBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOnboardedResponse> {
    return this.leads.onboard(params.leadId, body, adminActor(session));
  }
}
