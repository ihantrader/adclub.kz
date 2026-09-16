import { Controller, Get } from "@nestjs/common";
import { healthCheckResponseSchema, type HealthCheckResponse } from "@adclub/contracts";

@Controller("health")
export class HealthController {
  @Get()
  getHealth(): HealthCheckResponse {
    const body: HealthCheckResponse = {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    };
    return healthCheckResponseSchema.parse(body);
  }
}
