import { All, Controller, NotFoundException } from "@nestjs/common";

/**
 * Catches every route no controller matched and turns it into the same
 * unified error format as everything else (AC-5). Must stay the last
 * controller registered — see AppModule/WorkerModule wiring.
 */
@Controller()
export class NotFoundController {
  @All("*")
  handleUnmatchedRoute(): never {
    throw new NotFoundException("Route not found");
  }
}
