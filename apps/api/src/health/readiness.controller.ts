import { Controller, Inject, Res } from "@nestjs/common";
import { apiRoutes } from "@adclub/contracts";
import type { Response } from "express";
import { ApiRoute } from "../common/contract";
import { ReadinessService } from "./readiness.service";

/**
 * Readiness — separate from liveness (`/health`, always `ok` while the
 * process is running): reflects PostgreSQL, Redis and S3 state and
 * answers 503 while any of them is down (ARCHITECTURE 15.3, TASK-002).
 */
@Controller()
export class ReadinessController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required
  // here under `pnpm dev` (esbuild/tsx), not just under `tsc`.
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @ApiRoute(apiRoutes.getReadiness)
  async getReadiness(@Res() res: Response): Promise<void> {
    const body = await this.readiness.check();
    res.status(body.status === "ok" ? 200 : 503).json(body);
  }
}
