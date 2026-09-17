import { Global, Module, type DynamicModule } from "@nestjs/common";
import { JobAdmin } from "./job-admin.service";
import { JobMetrics } from "./job-metrics";
import type { JobDefinition } from "./job-definition";
import { JobQueue } from "./job-queue.service";
import { JobRegistry } from "./job-registry";
import { JobRunner } from "./job-runner.service";
import {
  defaultJobsTuning,
  JOBS_OPTIONS,
  type JobsModuleOptions,
  type JobsTuning,
} from "./jobs.options";
import { PeriodicJobStateStore } from "./periodic-job-state.store";
import { SweepRunner } from "./sweeper";

/**
 * Background jobs (ARCHITECTURE 13.1, 4.12). Global: modules put jobs on
 * the queue (`JobQueue`) and register implementations (`JobRegistry`)
 * without importing this module. The worker process (`role: "worker"`)
 * also runs them (`JobRunner`). The settings reader for schedules
 * (`JobSettingsReader`) comes from the global settings module.
 */
@Global()
@Module({})
export class JobsModule {
  static forRoot(options: {
    role: JobsModuleOptions["role"];
    catalog: readonly JobDefinition[];
    startOnBoot?: boolean;
    /** Sample the queue for metrics (the process that serves them). */
    metrics?: boolean;
    /** Tests shorten the timings. */
    tuning?: Partial<JobsTuning>;
  }): DynamicModule {
    const resolved: JobsModuleOptions = {
      role: options.role,
      catalog: options.catalog,
      startOnBoot: options.startOnBoot ?? true,
      tuning: { ...defaultJobsTuning, ...options.tuning },
    };
    return {
      module: JobsModule,
      providers: [
        { provide: JOBS_OPTIONS, useValue: resolved },
        JobQueue,
        JobAdmin,
        JobRegistry,
        SweepRunner,
        PeriodicJobStateStore,
        ...(options.metrics ? [JobMetrics] : []),
        ...(options.role === "worker" ? [JobRunner] : []),
      ],
      exports: [
        JobQueue,
        JobAdmin,
        JobRegistry,
        SweepRunner,
        ...(options.role === "worker" ? [JobRunner] : []),
      ],
    };
  }
}
