import { Body, Controller, Inject } from "@nestjs/common";
import {
  apiRoutes,
  vehicleMatchBodySchema,
  type VehicleMatchBody,
  type VehicleMatchResponse,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { VehicleMatching } from "./vehicle-matching";

/**
 * A car named by voice (TASK-060; SCREENS M-START-05, M-GAR-02): the text
 * the speech recognition gave, placed in the vehicle catalog — no AI, no
 * attempt of the person spent, the text written nowhere. Open to every
 * client, as the other `/vehicles/…` routes; an address is limited
 * (`vehicle_match_per_ip`) against a loop.
 */
@Controller()
export class VehicleMatchController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(VehicleMatching) private readonly matching: VehicleMatching) {}

  @RateLimitedRoute(apiRoutes.matchVehicleText)
  match(
    @Body(new ZodValidationPipe(vehicleMatchBodySchema)) body: VehicleMatchBody,
  ): Promise<VehicleMatchResponse> {
    return this.matching.phrase(body.text, new Date());
  }
}
