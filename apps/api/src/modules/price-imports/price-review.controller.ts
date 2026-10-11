import { Body, Controller, Headers, Inject, Param, Query } from "@nestjs/common";
import {
  adminCatalogRequestListQuerySchema,
  apiRoutes,
  catalogRequestListQuerySchema,
  catalogRequestPathSchema,
  choosePriceMissingBodySchema,
  createItemFromRequestBodySchema,
  decidePriceRowBodySchema,
  linkCatalogRequestBodySchema,
  priceImportPathSchema,
  priceImportVersionBodySchema,
  priceMissingQuerySchema,
  priceReviewRowPathSchema,
  priceReviewRowsQuerySchema,
  rejectCatalogRequestBodySchema,
  type AdminCatalogRequestListQuery,
  type AdminCatalogRequestPage,
  type AdminCatalogRequestResponse,
  type CatalogRequestDecidedResponse,
  type CatalogRequestListQuery,
  type CatalogRequestPath,
  type ChoosePriceMissingBody,
  type CreateItemFromRequestBody,
  type DecidePriceRowBody,
  type ItemFromRequestResponse,
  type LinkCatalogRequestBody,
  type PriceImportPath,
  type PriceImportResponse,
  type PriceImportVersionBody,
  type PriceMissingPage,
  type PriceMissingQuery,
  type PriceReviewRowPath,
  type PriceReviewRowsPage,
  type PriceReviewRowsQuery,
  type PriceReviewSummary,
  type PriceRowDecidedResponse,
  type PriceRowsSkippedResponse,
  type RejectCatalogRequestBody,
  type SupplierCatalogRequestPage,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { adminActor } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { CatalogRequestsService } from "./catalog-requests.service";
import { PriceReviewService } from "./price-review.service";
import type { PriceImportActor } from "./price-imports.service";

function importActor(session: AuthenticatedSession): PriceImportActor {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A cabinet route reached without a company");
  }
  return {
    supplierId: session.supplierId,
    memberId: session.supplierMemberId,
    accountId: session.accountId,
  };
}

function admin(session: AuthenticatedSession) {
  const actor = adminActor(session);
  if (actor.role !== "admin") throw new Error("An admin route reached without an administrator");
  return actor;
}

/**
 * The review of a matched price list and its application in the cabinet
 * (context `supplier`; TASK-047; S-PRICE-03, S-PRICE-04 — the screens come
 * with TASK-048), and the company's requests to add an item (S-MOD-01).
 */
@Controller()
export class PriceReviewController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(PriceReviewService) private readonly review: PriceReviewService,
    @Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService,
  ) {}

  @SessionRoute(apiRoutes.getPriceImportReview)
  summary(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceReviewSummary> {
    return this.review.summary(importActor(session).supplierId, params.importId);
  }

  @SessionRoute(apiRoutes.listPriceReviewRows)
  rows(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Query(new ZodValidationPipe(priceReviewRowsQuerySchema)) query: PriceReviewRowsQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceReviewRowsPage> {
    return this.review.rows(
      importActor(session).supplierId,
      params.importId,
      query,
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.decidePriceReviewRow)
  decide(
    @Param(new ZodValidationPipe(priceReviewRowPathSchema)) params: PriceReviewRowPath,
    @Body(new ZodValidationPipe(decidePriceRowBodySchema)) body: DecidePriceRowBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceRowDecidedResponse> {
    return this.review.decide(
      params.importId,
      Number(params.rowNo),
      body,
      importActor(session),
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.skipRemainingPriceRows)
  skipRemaining(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Body(new ZodValidationPipe(priceImportVersionBodySchema)) body: PriceImportVersionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceRowsSkippedResponse> {
    return this.review.skipRemaining(params.importId, body, importActor(session));
  }

  @SessionRoute(apiRoutes.listPriceMissingOffers)
  missing(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Query(new ZodValidationPipe(priceMissingQuerySchema)) query: PriceMissingQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceMissingPage> {
    return this.review.missing(
      importActor(session).supplierId,
      params.importId,
      query,
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.choosePriceMissingAction)
  async chooseMissing(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Body(new ZodValidationPipe(choosePriceMissingBodySchema)) body: ChoosePriceMissingBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportResponse> {
    return { import: await this.review.chooseMissing(params.importId, body, importActor(session)) };
  }

  @SessionRoute(apiRoutes.applyPriceImport)
  async apply(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Body(new ZodValidationPipe(priceImportVersionBodySchema)) body: PriceImportVersionBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportResponse> {
    return { import: await this.review.apply(params.importId, body, importActor(session)) };
  }

  @SessionRoute(apiRoutes.listSupplierCatalogRequests)
  catalogRequests(
    @Query(new ZodValidationPipe(catalogRequestListQuerySchema)) query: CatalogRequestListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierCatalogRequestPage> {
    return this.requests.supplierPage(
      importActor(session).supplierId,
      query,
      pickLanguage(acceptLanguage),
    );
  }
}

/** Requests to add an item, for the administrator (context `admin`; A-MOD-01). */
@Controller()
export class CatalogRequestsAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService) {}

  @SessionRoute(apiRoutes.listAdminCatalogRequests)
  list(
    @Query(new ZodValidationPipe(adminCatalogRequestListQuerySchema))
    query: AdminCatalogRequestListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<AdminCatalogRequestPage> {
    return this.requests.adminPage(query, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.getAdminCatalogRequest)
  card(
    @Param(new ZodValidationPipe(catalogRequestPathSchema)) params: CatalogRequestPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<AdminCatalogRequestResponse> {
    return this.requests.adminCard(params.requestId, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.createItemFromCatalogRequest)
  createItem(
    @Param(new ZodValidationPipe(catalogRequestPathSchema)) params: CatalogRequestPath,
    @Body(new ZodValidationPipe(createItemFromRequestBodySchema)) body: CreateItemFromRequestBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<ItemFromRequestResponse> {
    return this.requests.createItem(
      params.requestId,
      body,
      admin(session),
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.linkCatalogRequest)
  link(
    @Param(new ZodValidationPipe(catalogRequestPathSchema)) params: CatalogRequestPath,
    @Body(new ZodValidationPipe(linkCatalogRequestBodySchema)) body: LinkCatalogRequestBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CatalogRequestDecidedResponse> {
    return this.requests.link(params.requestId, body, admin(session), pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.rejectCatalogRequest)
  reject(
    @Param(new ZodValidationPipe(catalogRequestPathSchema)) params: CatalogRequestPath,
    @Body(new ZodValidationPipe(rejectCatalogRequestBodySchema)) body: RejectCatalogRequestBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CatalogRequestDecidedResponse> {
    return this.requests.reject(
      params.requestId,
      body,
      admin(session),
      pickLanguage(acceptLanguage),
    );
  }
}
