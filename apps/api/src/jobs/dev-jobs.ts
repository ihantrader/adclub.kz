import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService } from "../database";
import { dailyAt, defineJob, definePeriodicJob } from "./job-definition";
import type { JobHandler, JobRunOutcome, PeriodicJobHandler } from "./job-handler";
import { JobRegistry } from "./job-registry";

/**
 * Development and tests only (TASK-008): a job that always fails, to see
 * retries and the dead letter queue work end to end
 * (`operator dev:jobs:fail`). Not in the catalog of staging or production.
 *
 * With `failOnQuery` it fails the way a real bug in a job does
 * (TASK-009.A): on a SQL query bound to the note, so the failure is a
 * Drizzle error with the note among its parameters and PostgreSQL quoting
 * it — what must never reach the log or error monitoring as it is.
 */
export const devAlwaysFailingJob = defineJob({
  name: "dev.always-fails",
  payload: z.object({ note: z.string().max(200), failOnQuery: z.boolean().optional() }),
  timeoutSeconds: 30,
  retry: { limit: 2, delaySeconds: 1, backoff: false },
  singleton: false,
});

/**
 * Development and tests only (TASK-011.A): a daily job at the hour of the
 * setting `billing_notify_hour` that does nothing — so that a schedule
 * following a setting can be seen in dev (`jobs:status`) before the first
 * real daily job (billing) exists.
 */
export const devDailyJob = definePeriodicJob({
  name: "dev.daily-at-setting",
  timeoutSeconds: 30,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: async (setting) => dailyAt(await setting("billing_notify_hour")),
});

export const devJobCatalog = [devAlwaysFailingJob, devDailyJob];

@Injectable()
class DevAlwaysFailingJob implements JobHandler<{ note: string; failOnQuery?: boolean }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async run(payload: { note: string; failOnQuery?: boolean }): Promise<void> {
    if (payload.failOnQuery) {
      // The note is not a uuid: PostgreSQL refuses it and quotes it back.
      await this.database.db.execute(
        sql`SELECT ${payload.note}::uuid AS id, ${payload.note} AS note`,
      );
    }
    throw new Error("This development job always fails");
  }
}

const devDailyHandler: PeriodicJobHandler = {
  run: (): Promise<JobRunOutcome> => Promise.resolve({ worked: false }),
};

@Module({ providers: [DevAlwaysFailingJob] })
export class DevJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(DevAlwaysFailingJob) private readonly failing: DevAlwaysFailingJob,
  ) {}

  onModuleInit(): void {
    this.registry.handle(devAlwaysFailingJob, this.failing);
    this.registry.handlePeriodic(devDailyJob, devDailyHandler);
  }
}
