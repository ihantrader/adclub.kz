import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../database";
import { periodicJobState } from "./schema";

export interface PeriodicJobStateRow {
  name: string;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
}

const MAX_ERROR_LENGTH = 500;

/** Start, success and failure times of periodic jobs (`periodic_job_state`). */
@Injectable()
export class PeriodicJobStateStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async started(name: string, at: Date): Promise<void> {
    await this.database.db
      .insert(periodicJobState)
      .values({ name, lastStartedAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: periodicJobState.name,
        set: { lastStartedAt: at, updatedAt: at },
      });
  }

  async succeeded(name: string, at: Date): Promise<void> {
    await this.database.db
      .insert(periodicJobState)
      .values({ name, lastSucceededAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: periodicJobState.name,
        set: { lastSucceededAt: at, updatedAt: at },
      });
  }

  async failed(name: string, at: Date, error: string): Promise<void> {
    const lastError = error.slice(0, MAX_ERROR_LENGTH);
    await this.database.db
      .insert(periodicJobState)
      .values({ name, lastFailedAt: at, lastError, updatedAt: at })
      .onConflictDoUpdate({
        target: periodicJobState.name,
        set: { lastFailedAt: at, lastError, updatedAt: at },
      });
  }

  async all(): Promise<PeriodicJobStateRow[]> {
    return this.database.db
      .select({
        name: periodicJobState.name,
        lastStartedAt: periodicJobState.lastStartedAt,
        lastSucceededAt: periodicJobState.lastSucceededAt,
        lastFailedAt: periodicJobState.lastFailedAt,
        lastError: periodicJobState.lastError,
      })
      .from(periodicJobState)
      .orderBy(sql`${periodicJobState.name}`);
  }
}
