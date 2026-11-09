import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { Metrics } from "../../observability";
import { opsRunKinds } from "./schema";

/**
 * The backups and the restore check as metrics (TASK-055; ARCHITECTURE
 * 4.82, 15.3–15.4): when each kind last succeeded and whether its last run
 * did. Read from `ops_run` when the metrics are scraped — the scripts of
 * the `ops` container write it, the API serves the scrape.
 */
@Injectable()
export class OpsRunMetrics implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectOps(async () => {
      const { rows } = await this.database.db.execute<{
        kind: string;
        last_ok: boolean | null;
        last_success: number | null;
      }>(sql`
        SELECT k.kind,
          (SELECT r.ok FROM ops_run r WHERE r.kind = k.kind ORDER BY r.finished_at DESC LIMIT 1) AS last_ok,
          (SELECT extract(epoch FROM max(r.finished_at))::float8 FROM ops_run r
            WHERE r.kind = k.kind AND r.ok) AS last_success
        FROM unnest(${`{${opsRunKinds.join(",")}}`}::text[]) AS k(kind)
      `);
      for (const row of rows) {
        this.metrics.setOpsRun(
          row.kind,
          row.last_ok,
          row.last_success === null ? null : Number(row.last_success),
        );
      }
    });
  }
}

/** The metrics of the operations scripts, for the process that serves `GET /metrics`. */
@Module({ providers: [OpsRunMetrics] })
export class OpsRunMetricsModule {}
