import { Body, Controller, Headers, Inject, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  priceMatchAuditCorrectBodySchema,
  priceMatchAuditListQuerySchema,
  priceMatchAuditMetricsQuerySchema,
  priceMatchAuditPathSchema,
  priceMatchAuditWrongBodySchema,
  supplierMatchCorrectionQuerySchema,
  type PriceMatchAuditCard,
  type PriceMatchAuditCorrectBody,
  type PriceMatchAuditListQuery,
  type PriceMatchAuditMetrics,
  type PriceMatchAuditMetricsQuery,
  type PriceMatchAuditPage,
  type PriceMatchAuditPath,
  type PriceMatchAuditWrongBody,
  type SupplierMatchCorrectionPage,
  type SupplierMatchCorrectionQuery,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { PriceMatchAuditService } from "./price-match-audit.service";

function admin(session: AuthenticatedSession) {
  const actor = adminActor(session);
  if (actor.role !== "admin") throw new Error("An admin route reached without an administrator");
  return actor;
}

/** «Аудит сопоставлений» (A-MOD-04; TASK-065), context `admin`. */
@Controller()
export class PriceMatchAuditAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PriceMatchAuditService) private readonly audits: PriceMatchAuditService) {}

  @SessionRoute(apiRoutes.listPriceMatchAudits)
  list(
    @Query(new ZodValidationPipe(priceMatchAuditListQuerySchema)) query: PriceMatchAuditListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<PriceMatchAuditPage> {
    return this.audits.page(query, pickLanguage(acceptLanguage));
  }

  // Declared before `{auditId}`: «metrics» is not an id.
  @SessionRoute(apiRoutes.getPriceMatchAuditMetrics)
  metrics(
    @Query(new ZodValidationPipe(priceMatchAuditMetricsQuerySchema))
    query: PriceMatchAuditMetricsQuery,
  ): Promise<PriceMatchAuditMetrics> {
    return this.audits.metrics(query);
  }

  @SessionRoute(apiRoutes.getPriceMatchAudit)
  card(
    @Param(new ZodValidationPipe(priceMatchAuditPathSchema)) params: PriceMatchAuditPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<PriceMatchAuditCard> {
    return this.audits.card(params.auditId, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.markPriceMatchAuditCorrect)
  correct(
    @Param(new ZodValidationPipe(priceMatchAuditPathSchema)) params: PriceMatchAuditPath,
    @Body(new ZodValidationPipe(priceMatchAuditCorrectBodySchema)) body: PriceMatchAuditCorrectBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceMatchAuditCard> {
    return this.audits.correct(params.auditId, body, admin(session), pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.markPriceMatchAuditWrong)
  wrong(
    @Param(new ZodValidationPipe(priceMatchAuditPathSchema)) params: PriceMatchAuditPath,
    @Body(new ZodValidationPipe(priceMatchAuditWrongBodySchema)) body: PriceMatchAuditWrongBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceMatchAuditCard> {
    return this.audits.wrong(params.auditId, body, admin(session), pickLanguage(acceptLanguage));
  }
}

/** Corrections of the company's matches in «Модерация» (S-MOD-01; TASK-065), context `supplier`. */
@Controller()
export class SupplierMatchCorrectionsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PriceMatchAuditService) private readonly audits: PriceMatchAuditService) {}

  @SessionRoute(apiRoutes.listSupplierMatchCorrections)
  list(
    @Query(new ZodValidationPipe(supplierMatchCorrectionQuerySchema))
    query: SupplierMatchCorrectionQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierMatchCorrectionPage> {
    if (!session.supplierId || !session.supplierMemberId) {
      throw new Error("A cabinet route reached without a company");
    }
    return this.audits.supplierCorrections(
      { supplierId: session.supplierId, memberId: session.supplierMemberId },
      query,
      pickLanguage(acceptLanguage),
    );
  }
}
