import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import type { DependencyCheck } from "@adclub/contracts";
import { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../config";
import { measureCheck } from "../common/health/measure-check";

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redis.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      // ioredis reconnects on its own (default retryStrategy) — this is
      // what makes readiness recover after Redis comes back without a
      // server restart (edge case, TASK-002).
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    // Without a listener, ioredis's 'error' event crashes the process
    // (Node's default behavior for unhandled 'error' events) — that would
    // break "the server starts even if a dependency is down at boot".
    this.client.on("error", (error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
  }

  checkHealth(): Promise<DependencyCheck> {
    return measureCheck(async () => {
      await this.client.ping();
    });
  }

  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
