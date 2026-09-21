import { Controller, Inject, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import {
  apiRoutes,
  uploadVehicleImportQuerySchema,
  vehicleImportIdPathSchema,
  vehicleImportListQuerySchema,
  vehicleImportRowsQuerySchema,
  type AdminVehicleImportPage,
  type AdminVehicleImportResponse,
  type UploadVehicleImportQuery,
  type VehicleImportIdPath,
  type VehicleImportListQuery,
  type VehicleImportRowsPage,
  type VehicleImportRowsQuery,
  type VehicleImportTemplateResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../../identity";
import { VehicleImportService, type ImportActor } from "./vehicle-import.service";

function importActor(session: AuthenticatedSession): ImportActor {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { role: "admin", adminId: session.adminUserId, accountId: session.accountId };
}

/**
 * Imports of the vehicle catalog in the admin panel (context `admin`;
 * TASK-014; SCREENS A-CAR-02). The upload takes the file as the body
 * (`UploadBodyMiddleware` has read the bytes by then, ARCHITECTURE 4.22
 * I204); everything else is in the path and the query.
 */
@Controller()
export class VehicleImportController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(VehicleImportService) private readonly imports: VehicleImportService) {}

  @SessionRoute(apiRoutes.getVehicleImportTemplate)
  template(): Promise<VehicleImportTemplateResponse> {
    return this.imports.template();
  }

  @SessionRoute(apiRoutes.uploadVehicleImport)
  async upload(
    @Query(new ZodValidationPipe(uploadVehicleImportQuerySchema)) query: UploadVehicleImportQuery,
    @Req() request: Request,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleImportResponse> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    return { import: await this.imports.upload(body, query, importActor(session)) };
  }

  @SessionRoute(apiRoutes.listVehicleImports)
  list(
    @Query(new ZodValidationPipe(vehicleImportListQuerySchema)) query: VehicleImportListQuery,
  ): Promise<AdminVehicleImportPage> {
    return this.imports.page(query);
  }

  @SessionRoute(apiRoutes.getVehicleImport)
  async get(
    @Param(new ZodValidationPipe(vehicleImportIdPathSchema)) params: VehicleImportIdPath,
  ): Promise<AdminVehicleImportResponse> {
    return { import: await this.imports.get(params.importId) };
  }

  @SessionRoute(apiRoutes.listVehicleImportRows)
  rows(
    @Param(new ZodValidationPipe(vehicleImportIdPathSchema)) params: VehicleImportIdPath,
    @Query(new ZodValidationPipe(vehicleImportRowsQuerySchema)) query: VehicleImportRowsQuery,
  ): Promise<VehicleImportRowsPage> {
    return this.imports.rows(params.importId, query);
  }

  @SessionRoute(apiRoutes.applyVehicleImport)
  async apply(
    @Param(new ZodValidationPipe(vehicleImportIdPathSchema)) params: VehicleImportIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleImportResponse> {
    return { import: await this.imports.apply(params.importId, importActor(session)) };
  }

  @SessionRoute(apiRoutes.cancelVehicleImport)
  async cancel(
    @Param(new ZodValidationPipe(vehicleImportIdPathSchema)) params: VehicleImportIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminVehicleImportResponse> {
    return { import: await this.imports.cancel(params.importId, importActor(session)) };
  }
}
