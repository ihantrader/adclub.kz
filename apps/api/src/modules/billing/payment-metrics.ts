import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { Metrics } from "../../observability";

const STATUSES = ["created", "unavailable", "unknown", "succeeded", "declined", "cancelled"];
const KINDS = ["first", "scheduled", "retry", "manual"];

/**
 * The charges of suppliers' cards as metrics (TASK-042; ARCHITECTURE 15.3):
 * how many attempts there are by outcome and kind, and how many wait for
 * another try because the provider could not take them. Read from the
 * database when the metrics are scraped — the worker charges, the API serves
 * the scrape, and the worker's own memory is never scraped.
 */
@Injectable()
export class PaymentMetrics implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectPayments(async () => {
      const { rows } = await this.database.db.execute<{ status: string; kind: string; n: number }>(
        sql`SELECT status, kind, count(*)::int AS n FROM payment_attempt GROUP BY status, kind`,
      );
      const seen = new Map(rows.map((row) => [`${row.status}/${row.kind}`, row.n]));
      for (const status of STATUSES) {
        for (const kind of KINDS) {
          this.metrics.setPaymentAttempts(status, kind, seen.get(`${status}/${kind}`) ?? 0);
        }
      }
      for (const state of ["unavailable", "unknown"]) {
        const waiting = rows
          .filter((row) => row.status === state)
          .reduce((sum, row) => sum + row.n, 0);
        this.metrics.setPaymentRetryQueue(state, waiting);
      }
    });
  }
}
