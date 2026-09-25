import { Controller, Inject, Query } from "@nestjs/common";
import {
  adminSignalListQuerySchema,
  apiRoutes,
  type AdminSignalListQuery,
  type AdminSignalPage,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { SessionRoute } from "../identity";
import { AdminSignals } from "./admin-signals.service";

/** Signals for a person to look at (context `admin`; SCREENS A-HOME). */
@Controller()
export class AdminSignalsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AdminSignals) private readonly signals: AdminSignals) {}

  @SessionRoute(apiRoutes.listAdminSignals)
  list(
    @Query(new ZodValidationPipe(adminSignalListQuerySchema)) query: AdminSignalListQuery,
  ): Promise<AdminSignalPage> {
    return this.signals.page(query);
  }
}
