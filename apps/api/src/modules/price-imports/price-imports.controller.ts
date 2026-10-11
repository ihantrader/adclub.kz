import { Body, Controller, Inject, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import {
  adminSupplierPriceImportsPathSchema,
  apiRoutes,
  confirmPriceColumnsBodySchema,
  priceImportListQuerySchema,
  priceImportPathSchema,
  priceImportRowsQuerySchema,
  uploadPriceImportQuerySchema,
  type AdminPriceImportPage,
  type AdminSupplierPriceImportsPath,
  type ConfirmPriceColumnsBody,
  type PriceImportDetailResponse,
  type PriceImportListQuery,
  type PriceImportPage,
  type PriceImportPath,
  type PriceImportResponse,
  type PriceImportRowsPage,
  type PriceImportRowsQuery,
  type UploadPriceImportQuery,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { PriceImportsService, type PriceImportActor } from "./price-imports.service";

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

/**
 * Price list imports in the cabinet (context `supplier`; TASK-046; SCREENS
 * S-PRICE-01, S-PRICE-02). The company is always the session's. The upload
 * takes the file as the body (`UploadBodyMiddleware` has read the bytes).
 */
@Controller()
export class PriceImportsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PriceImportsService) private readonly imports: PriceImportsService) {}

  @SessionRoute(apiRoutes.uploadPriceImport)
  async upload(
    @Query(new ZodValidationPipe(uploadPriceImportQuerySchema)) query: UploadPriceImportQuery,
    @Req() request: Request,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportResponse> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    return { import: await this.imports.upload(body, query, importActor(session)) };
  }

  @SessionRoute(apiRoutes.listPriceImports)
  list(
    @Query(new ZodValidationPipe(priceImportListQuerySchema)) query: PriceImportListQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportPage> {
    return this.imports.page(importActor(session).supplierId, query);
  }

  @SessionRoute(apiRoutes.getPriceImport)
  get(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportDetailResponse> {
    return this.imports.detail(importActor(session).supplierId, params.importId);
  }

  @SessionRoute(apiRoutes.confirmPriceImportColumns)
  async confirm(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Body(new ZodValidationPipe(confirmPriceColumnsBodySchema)) body: ConfirmPriceColumnsBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportResponse> {
    return {
      import: await this.imports.confirmColumns(params.importId, body, importActor(session)),
    };
  }

  @SessionRoute(apiRoutes.listPriceImportRows)
  rows(
    @Param(new ZodValidationPipe(priceImportPathSchema)) params: PriceImportPath,
    @Query(new ZodValidationPipe(priceImportRowsQuerySchema)) query: PriceImportRowsQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<PriceImportRowsPage> {
    return this.imports.rows(importActor(session).supplierId, params.importId, query);
  }
}

/** A supplier's uploads for the administrator, read only (A-SUP-03 «Прайс»). */
@Controller()
export class PriceImportsAdminController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PriceImportsService) private readonly imports: PriceImportsService) {}

  @SessionRoute(apiRoutes.listAdminSupplierPriceImports)
  list(
    @Param(new ZodValidationPipe(adminSupplierPriceImportsPathSchema))
    params: AdminSupplierPriceImportsPath,
    @Query(new ZodValidationPipe(priceImportListQuerySchema)) query: PriceImportListQuery,
  ): Promise<AdminPriceImportPage> {
    return this.imports.adminPage(params.supplierId, query);
  }
}
