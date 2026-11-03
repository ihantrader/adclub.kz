import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { DependencyCheck } from "@adclub/contracts";
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { APP_CONFIG, type AppConfig } from "../config";
import { describeError } from "../common/health/describe-error";
import { measureCheck } from "../common/health/measure-check";
import { withAfterCommitScope } from "./after-commit";

/**
 * Anything queries can run on: the database itself or an open
 * transaction — for store methods a caller may want inside its own
 * transaction.
 */
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, Record<string, never>>;

const STATEMENT_TIMEOUT_MS = 2000;
const READ_TIMEOUT_MS = 10_000;

/**
 * pg's `query_timeout` only stops waiting: the statement goes on in the
 * server, the ROLLBACK queued behind it times out in turn, and drizzle hands
 * the connection back to the pool in the middle of its transaction — «idle in
 * transaction», holding its locks, for as long as the pool keeps it (TASK-042.B:
 * sweepers' transactions blocked every TRUNCATE for minutes). A connection
 * whose read timed out is ended instead: the server then rolls it back, and
 * the pool drops it.
 */
function closeOnReadTimeout(client: PoolClient): void {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  client.query = ((...args: unknown[]) => {
    const result = query(...args);
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        if (error instanceof Error && error.message === "Query read timeout") {
          void client.end().catch(() => undefined);
        }
      });
    }
    return result;
  }) as typeof client.query;
}

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
      // The server ends a statement that runs (or waits for a lock) too long:
      // its transaction is aborted there too, and the ROLLBACK that follows is
      // answered at once (I845).
      statement_timeout: STATEMENT_TIMEOUT_MS,
      // Only for a server that stopped answering at all. When pg gives up
      // reading, the statement may still be running and the connection is
      // closed rather than reused (`closeOnReadTimeout`).
      query_timeout: READ_TIMEOUT_MS,
    });
    this.pool.on("connect", closeOnReadTimeout);
    // Every transaction of the application is opened on this handle, so
    // work deferred with `afterCommit` runs exactly when one commits
    // (ARCHITECTURE 4.13).
    this.db = withAfterCommitScope(drizzle(this.pool));

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
