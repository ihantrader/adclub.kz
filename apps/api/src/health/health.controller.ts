import { Controller } from "@nestjs/common";
import { apiRoutes, healthCheckResponseSchema, type HealthCheckResponse } from "@adclub/contracts";
import { ApiRoute } from "../common/contract";

@Controller()
export class HealthController {
  @ApiRoute(apiRoutes.getHealth)
  getHealth(): HealthCheckResponse {
    const body: HealthCheckResponse = {
      status: "ok",
      service: "api",
    };
    return healthCheckResponseSchema.parse(body);
  }
}
