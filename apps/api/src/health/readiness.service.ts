import { Inject, Injectable } from "@nestjs/common";
import { readinessResponseSchema, type ReadinessResponse } from "@adclub/contracts";
import { DatabaseService } from "../database";
import { RedisService } from "../redis";
import { StorageService } from "../storage";

@Injectable()
export class ReadinessService {
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

    return readinessResponseSchema.parse({ status, checks: { postgres, redis, s3 } });
  }
}
