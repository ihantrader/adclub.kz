import { Controller, Inject, Query, Req } from "@nestjs/common";
import {
  apiRoutes,
  dashboardQuerySchema,
  type DashboardQuery,
  type DashboardResponse,
} from "@adclub/contracts";
import type { Request } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { OptionalSession, OptionalSessionRoute, type AuthenticatedSession } from "../identity";
import { photoReaderOf } from "../vehicle-document";
import { DashboardService } from "./dashboard.service";

/**
 * The mileage read off a photo of the dashboard (TASK-058, M-GAR-07). Open
 * to a guest — a guest's car lives on the device — so the reader is the
 * account of a session or the device a guest names. The body is the photo
 * itself, in this request only.
 */
@Controller()
export class DashboardController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DashboardService) private readonly dashboards: DashboardService) {}

  @OptionalSessionRoute(apiRoutes.recognizeDashboard)
  recognize(
    @Query(new ZodValidationPipe(dashboardQuerySchema)) query: DashboardQuery,
    @OptionalSession() session: AuthenticatedSession | null,
    @Req() request: Request,
  ): Promise<DashboardResponse> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    return this.dashboards.recognize(photoReaderOf(session, query.deviceId, request), body);
  }
}
