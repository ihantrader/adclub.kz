import { Controller, Inject, Module, Param, Query } from "@nestjs/common";
import {
  apiRoutes,
  supplierAdminPathSchema,
  supplierStatsQuerySchema,
  type SupplierAdminPath,
  type SupplierStatsQuery,
  type SupplierStatsResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { SupplierStatsService } from "./supplier-stats.service";

/** S-STAT-01 «Статистика» of the cabinet (context `supplier`): only the session's company. */
@Controller()
export class SupplierStatsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierStatsService) private readonly stats: SupplierStatsService) {}

  @SessionRoute(apiRoutes.getSupplierStats)
  async own(
    @Query(new ZodValidationPipe(supplierStatsQuerySchema)) query: SupplierStatsQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierStatsResponse> {
    if (!session.supplierId) {
      throw new Error("A cabinet route reached without a company");
    }
    return { stats: await this.stats.of(session.supplierId, query.period) };
  }
}

/** The same numbers on the admin's card of the supplier (context `admin`). */
@Controller()
export class AdminSupplierStatsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierStatsService) private readonly stats: SupplierStatsService) {}

  @SessionRoute(apiRoutes.getAdminSupplierStats)
  async ofSupplier(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Query(new ZodValidationPipe(supplierStatsQuerySchema)) query: SupplierStatsQuery,
  ): Promise<SupplierStatsResponse> {
    return { stats: await this.stats.ofKnown(params.supplierId, query.period) };
  }
}

/** The statistics of a supplier (TASK-071; ARCHITECTURE 4.89). */
@Module({
  controllers: [SupplierStatsController, AdminSupplierStatsController],
  providers: [SupplierStatsService],
  exports: [SupplierStatsService],
})
export class SupplierStatsModule {}
