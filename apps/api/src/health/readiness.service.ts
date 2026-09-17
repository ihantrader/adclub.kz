import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  readinessResponseSchema,
  type DependencyCheck,
  type ReadinessResponse,
} from "@adclub/contracts";
import { DatabaseService } from "../database";
import { RedisService } from "../redis";
import { StorageService } from "../storage";

/**
 * `checkHealth()` on each dependency service returns the driver's own
 * error message (addresses, ports, usernames) for local diagnostics
 * (`DatabaseService.checkHealth` etc.). None of that may leave the process
 * over `/ready` (TASK-005.A) — this logs the real reason and returns only
 * the dependency's `status`/`latencyMs` for the HTTP response.
 */
function sanitizeForResponse(
  name: "postgres" | "redis" | "s3",
  check: DependencyCheck,
  logger: Logger,
): DependencyCheck {
  if (check.status === "ok") {
    return check;
  }
  logger.warn(`Dependency check failed: ${name}: ${check.error ?? "unknown error"}`);
  return { status: "error" };
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required
  // here under `pnpm dev` (esbuild/tsx), not just under `tsc`.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async check(): Promise<ReadinessResponse> {
    const [postgres, redis, s3] = await Promise.all([
      this.database.checkHealth(),
      this.redis.checkHealth(),
      this.storage.checkHealth(),
    ]);

    const status = [postgres, redis, s3].every((check) => check.status === "ok")
      ? "ok"
      : "degraded";

    return readinessResponseSchema.parse({
      status,
      checks: {
        postgres: sanitizeForResponse("postgres", postgres, this.logger),
        redis: sanitizeForResponse("redis", redis, this.logger),
        s3: sanitizeForResponse("s3", s3, this.logger),
      },
    });
  }
}
