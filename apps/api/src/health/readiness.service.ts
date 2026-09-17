import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  readinessResponseSchema,
  type DependencyCheck,
  type ReadinessResponse,
} from "@adclub/contracts";
import { DatabaseService } from "../database";
import { Metrics } from "../observability";
import { RedisService } from "../redis";
import { StorageService } from "../storage";

type DependencyName = "postgres" | "redis" | "s3";

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  /** The state each dependency was last seen in, so only changes are logged. */
  private readonly lastSeen = new Map<DependencyName, "ok" | "error">();

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required
  // here under `pnpm dev` (esbuild/tsx), not just under `tsc`.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(Metrics) private readonly metrics: Metrics,
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
        postgres: this.record("postgres", postgres),
        redis: this.record("redis", redis),
        s3: this.record("s3", s3),
      },
    });
  }

  /**
   * `checkHealth()` on each dependency service returns the driver's own
   * error message (addresses, ports, usernames) for local diagnostics
   * (`DatabaseService.checkHealth` etc.). None of that may leave the
   * process over `/ready` (TASK-005.A) — only the dependency's
   * `status`/`latencyMs` is answered.
   *
   * A load balancer polls this route constantly, so a dependency that is
   * down must not write a line on every poll (TASK-005.A note, closed in
   * TASK-009): the log gets the change of state, the metric
   * `adclub_dependency_up` carries the state itself.
   */
  private record(name: DependencyName, check: DependencyCheck): DependencyCheck {
    const state = check.status === "ok" ? "ok" : "error";
    this.metrics.setDependencyUp(name, state === "ok");
    const before = this.lastSeen.get(name);
    if (before !== state) {
      this.lastSeen.set(name, state);
      if (state === "error") {
        this.logger.warn(`Dependency went down: ${name}: ${check.error ?? "unknown error"}`);
      } else if (before !== undefined) {
        this.logger.log(`Dependency is back: ${name}`);
      }
    }
    return check.status === "ok" ? check : { status: "error" };
  }
}
