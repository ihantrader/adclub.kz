import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { DependencyCheck } from "@adclub/contracts";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../config";
import { describeError } from "../common/health/describe-error";
import { measureCheck } from "../common/health/measure-check";

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;
  readonly db: NodePgDatabase;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: 10,
      connectionTimeoutMillis: 5000,
      query_timeout: 2000,
    });
    this.db = drizzle(this.pool);

    // pg.Pool re-emits errors from idle clients on the pool itself; without
    // a listener, an error on an idle connection (e.g. the database going
    // away) would crash the process instead of just failing readiness.
    this.pool.on("error", (error) => {
      this.logger.warn(`PostgreSQL pool error: ${describeError(error)}`);
    });
  }

  async onModuleInit(): Promise<void> {
    // Attempt an eager connection so problems are visible in logs right
    // away, but never fail startup on it: readiness (not liveness) is
    // where an unavailable dependency belongs (edge case, TASK-002).
    try {
      await this.pool.query("SELECT 1");
    } catch (error) {
      this.logger.warn(`PostgreSQL not reachable at startup: ${describeError(error)}`);
    }
  }

  checkHealth(): Promise<DependencyCheck> {
    return measureCheck(async () => {
      await this.pool.query("SELECT 1");
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
