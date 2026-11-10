import { Body, Controller, Headers, Inject, Param, Query, Res } from "@nestjs/common";
import {
  apiRoutes,
  confirmMaintenanceItemsBodySchema,
  copyMaintenancePlanBodySchema,
  createMaintenanceItemBodySchema,
  createMaintenancePlanBodySchema,
  draftMaintenancePlanBodySchema,
  maintenanceItemPathSchema,
  maintenancePlanCheckBodySchema,
  maintenancePlanListQuerySchema,
  maintenancePlanPathSchema,
  maintenancePlanQuerySchema,
  reorderMaintenanceItemsBodySchema,
  setMaintenanceItemStatusBodySchema,
  setMaintenancePlanStatusBodySchema,
  updateMaintenanceItemBodySchema,
  updateMaintenancePlanBodySchema,
  type AdminMaintenancePlanPage,
  type AdminMaintenancePlanResponse,
  type ConfirmMaintenanceItemsBody,
  type ConfirmMaintenanceItemsResponse,
  type CopyMaintenancePlanBody,
  type CreateMaintenanceItemBody,
  type CreateMaintenancePlanBody,
  type DraftMaintenancePlanBody,
  type MaintenanceItemPath,
  type MaintenancePlanAnswer,
  type MaintenancePlanCheckBody,
  type MaintenancePlanCheckResponse,
  type MaintenancePlanListQuery,
  type MaintenancePlanPath,
  type MaintenancePlanQuery,
  type ReorderMaintenanceItemsBody,
  type SetMaintenanceItemStatusBody,
  type SetMaintenancePlanStatusBody,
  type UpdateMaintenanceItemBody,
  type UpdateMaintenancePlanBody,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { adminActor } from "../catalog";
import {
  CurrentSession,
  OptionalSession,
  SessionRoute,
  type AuthenticatedSession,
} from "../identity";
import { roleSafeCaching, ShowcaseService } from "../showcase";
import { MaintenanceAnswers } from "./maintenance-answers.service";
import { MaintenanceDrafts } from "./maintenance-draft.service";
import { MaintenancePlansService } from "./maintenance-plans.service";

/**
 * Maintenance plans (TASK-061; ARCHITECTURE 4.84): the answer for a car —
 * open to guests and users as the catalog is (limited and cached the same
 * way), and the plans kept by the administrator (context `admin`).
 */
@Controller()
export class MaintenanceController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(MaintenancePlansService) private readonly plans: MaintenancePlansService,
    @Inject(MaintenanceDrafts) private readonly drafts: MaintenanceDrafts,
    @Inject(MaintenanceAnswers) private readonly answers: MaintenanceAnswers,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
  ) {}

  @RateLimitedRoute(apiRoutes.getMaintenancePlan)
  async plan(
    @Query(new ZodValidationPipe(maintenancePlanQuerySchema)) query: MaintenancePlanQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @OptionalSession() session: AuthenticatedSession | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MaintenancePlanAnswer> {
    const lang = pickLanguage(acceptLanguage);
    const viewer = await this.showcase.viewer(session);
    const answer = await this.answers.answer(query, viewer, lang);
    roleSafeCaching(response, lang, session !== null);
    return answer;
  }

  // ----------------------------------------------------------------- admin

  @SessionRoute(apiRoutes.listMaintenancePlans)
  list(
    @Query(new ZodValidationPipe(maintenancePlanListQuerySchema)) query: MaintenancePlanListQuery,
  ): Promise<AdminMaintenancePlanPage> {
    return this.plans.list(query);
  }

  @SessionRoute(apiRoutes.createMaintenancePlan)
  create(
    @Body(new ZodValidationPipe(createMaintenancePlanBodySchema)) body: CreateMaintenancePlanBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.create(body, adminActor(session));
  }

  @RateLimitedRoute(apiRoutes.draftMaintenancePlan)
  async draft(
    @Body(new ZodValidationPipe(draftMaintenancePlanBodySchema)) body: DraftMaintenancePlanBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return (await this.drafts.draft(body, adminActor(session))).response;
  }

  @SessionRoute(apiRoutes.getAdminMaintenancePlan)
  detail(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.detail(params.planId);
  }

  @SessionRoute(apiRoutes.updateMaintenancePlan)
  update(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(updateMaintenancePlanBodySchema)) body: UpdateMaintenancePlanBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.update(params.planId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.setMaintenancePlanStatus)
  setStatus(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(setMaintenancePlanStatusBodySchema))
    body: SetMaintenancePlanStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.setStatus(params.planId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.copyMaintenancePlan)
  copy(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(copyMaintenancePlanBodySchema)) body: CopyMaintenancePlanBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.copy(params.planId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.checkMaintenancePlan)
  check(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(maintenancePlanCheckBodySchema)) body: MaintenancePlanCheckBody,
  ): Promise<MaintenancePlanCheckResponse> {
    return this.answers.check(params.planId, body);
  }

  @SessionRoute(apiRoutes.createMaintenanceItem)
  createItem(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(createMaintenanceItemBodySchema)) body: CreateMaintenanceItemBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.createItem(params.planId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.confirmMaintenanceItems)
  confirmAll(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(confirmMaintenanceItemsBodySchema))
    body: ConfirmMaintenanceItemsBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ConfirmMaintenanceItemsResponse> {
    return this.plans.confirmAll(params.planId, body.expectedVersion, adminActor(session));
  }

  @SessionRoute(apiRoutes.reorderMaintenanceItems)
  reorder(
    @Param(new ZodValidationPipe(maintenancePlanPathSchema)) params: MaintenancePlanPath,
    @Body(new ZodValidationPipe(reorderMaintenanceItemsBodySchema))
    body: ReorderMaintenanceItemsBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.reorder(params.planId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.updateMaintenanceItem)
  updateItem(
    @Param(new ZodValidationPipe(maintenanceItemPathSchema)) params: MaintenanceItemPath,
    @Body(new ZodValidationPipe(updateMaintenanceItemBodySchema)) body: UpdateMaintenanceItemBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.updateItem(params.itemId, body, adminActor(session));
  }

  @SessionRoute(apiRoutes.setMaintenanceItemStatus)
  setItemStatus(
    @Param(new ZodValidationPipe(maintenanceItemPathSchema)) params: MaintenanceItemPath,
    @Body(new ZodValidationPipe(setMaintenanceItemStatusBodySchema))
    body: SetMaintenanceItemStatusBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.plans.setItemStatus(params.itemId, body, adminActor(session));
  }
}
