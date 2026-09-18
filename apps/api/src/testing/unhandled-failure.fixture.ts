import "reflect-metadata";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { JsonLoggerService } from "../common/logging/json-logger.service";
import { reportUnhandledFailures } from "../common/shutdown/unhandled-failures";
import type { AppConfig } from "../config";
import { ErrorReporter } from "../observability/error-reporter.service";
import { Metrics } from "../observability/metrics.service";
import { parseMonitoringDsn } from "../observability/monitoring-dsn";

/**
 * A process of its own for `observability.integration.test.ts`
 * (TASK-009.A): wired like the API and the worker (`reportUnhandledFailures`
 * with the real logger and error reporter), it fails twice on a real SQL
 * query bound to personal data — first a rejection nobody handles (the
 * process must go on), then an exception thrown while an HTTP request is
 * being handled (the process must report it and exit with 1).
 *
 * Env: `DATABASE_URL`, `MONITORING_DSN`, `FIXTURE_NOTE` (the personal data).
 */

const note = process.env.FIXTURE_NOTE ?? "";
const config = {
  logLevel: "log",
  monitoring: {
    target: parseMonitoringDsn(process.env.MONITORING_DSN ?? ""),
    environment: "fixture",
  },
} as AppConfig;
const logger = new JsonLoggerService(config);
const reporter = new ErrorReporter(config, new Metrics());
reportUnhandledFailures({ logger, reporter, context: "Fixture", exitTimeoutMs: 3000 });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const db = drizzle(pool);
/** A query PostgreSQL refuses, quoting the value back: a real `DrizzleQueryError`. */
const failingQuery = () => db.execute(sql`SELECT ${note}::uuid AS id, ${note} AS note`);

// 1. A rejection nobody handles: reported, and the process goes on.
// (A Drizzle query runs only once awaited: `then` starts it.)
void failingQuery().then(() => undefined);

// 2. An exception escaping while a request is being handled: reported, then exit 1.
const server = createServer((_incoming, response) => {
  failingQuery().catch((error: unknown) => {
    setImmediate(() => {
      response.end();
      throw error;
    });
  });
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  setTimeout(() => {
    logger.log("Fixture still running after the unhandled rejection", "Fixture");
    request({ host: "127.0.0.1", port, path: "/" })
      .on("error", () => undefined)
      .end();
  }, 1000);
});
