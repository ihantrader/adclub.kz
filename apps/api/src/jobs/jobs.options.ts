import type { JobDefinition } from "./job-definition";

export const JOBS_OPTIONS = Symbol("JOBS_OPTIONS");

/** Timings of the queue; tests shorten them, the processes keep the defaults. */
export interface JobsTuning {
  /** How often a worker looks for new jobs of each queue. */
  pollingIntervalSeconds: number;
  /** pg-boss: expired runs, queue counts (worker). */
  monitorIntervalSeconds: number;
  superviseIntervalSeconds: number;
  queueCacheIntervalSeconds: number;
  /** pg-boss: how often schedules are evaluated and scheduled jobs sent (worker). */
  cronMonitorIntervalSeconds: number;
  cronWorkerIntervalSeconds: number;
  /** How often schedules are recomputed from settings (worker). */
  scheduleSyncIntervalMs: number;
  /** How often the worker sums up periodic runs that had nothing to do (TASK-009). */
  quietSummaryIntervalMs: number;
  /** Pause before another attempt to start the queue (database unreachable). */
  startRetryMs: number;
  /** How long running jobs may finish when the process stops. */
  stopTimeoutMs: number;
}

export const defaultJobsTuning: JobsTuning = {
  pollingIntervalSeconds: 2,
  monitorIntervalSeconds: 60,
  superviseIntervalSeconds: 60,
  queueCacheIntervalSeconds: 60,
  cronMonitorIntervalSeconds: 30,
  cronWorkerIntervalSeconds: 5,
  scheduleSyncIntervalMs: 15_000,
  quietSummaryIntervalMs: 60 * 60 * 1000,
  startRetryMs: 5_000,
  // The process gives its whole shutdown 10 s (common/shutdown).
  stopTimeoutMs: 7_000,
};

export interface JobsModuleOptions {
  /** `worker` executes jobs and runs schedules; `producer` only puts jobs on the queue. */
  role: "producer" | "worker";
  /** Every declared job (`background-jobs.ts`). */
  catalog: readonly JobDefinition[];
  /** Start the queue with the process (false: on first use — the operator command). */
  startOnBoot: boolean;
  tuning: JobsTuning;
}
