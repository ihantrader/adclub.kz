import { Controller, Inject } from "@nestjs/common";
import { apiRoutes, type AdminHome } from "@adclub/contracts";
import { SessionRoute } from "../identity";
import { AdminHomeService } from "./admin-home.service";

/** The administrator's queue of attention (context `admin`; SCREENS A-HOME). */
@Controller()
export class AdminHomeController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(AdminHomeService) private readonly home: AdminHomeService) {}

  @SessionRoute(apiRoutes.getAdminHome)
  summary(): Promise<AdminHome> {
    return this.home.summary();
  }
}
