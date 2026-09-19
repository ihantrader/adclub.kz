import type { z } from "zod";
import type { SettingKey, SettingValue } from "../modules/settings";

/**
 * Background job declarations (ARCHITECTURE 13.1, 4.12). A declaration is
 * a constant a module exports: the name, how long a run may take, retries,
 * whether runs are singletons, and — for a periodic job — its schedule.
 * The implementation (`JobHandler`, `Sweeper`) is a provider of the same
 * module, registered in the worker (`JobRegistry`).
 *
 * Handlers are idempotent: a run may be repeated (a retry, a worker that
 * stopped mid-run, a job the operator retried) and repeating it must not
 * damage data.
 */

/** People's time is Almaty time (ARCHITECTURE 13.3); storage is UTC. */
export const ALMATY_TIME_ZONE = "Asia/Almaty";

/** Dead jobs of `<name>` wait in `<name>.dead`. */
export const DEAD_LETTER_SUFFIX = ".dead";

const JOB_NAME = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/;

export interface JobRetry {
  /** Retries after the first run (0 — none). */
  limit: number;
  /** Pause before a retry, seconds. */
  delaySeconds: number;
  /** Doubles the pause with every retry (with jitter), up to `maxDelaySeconds`. */
  backoff: boolean;
  maxDelaySeconds?: number;
}

interface JobDefinitionBase {
  /** `<module>.<job>`, e.g. `identity.cleanup-sessions`. */
  readonly name: string;
  /** A run taking longer fails (and is retried). */
  readonly timeoutSeconds: number;
  readonly retry: JobRetry;
  /**
   * At most one run at a time across all workers, and at most one waiting:
   * a request while one already waits is dropped (`enqueue` returns null).
   */
  readonly singleton: boolean;
}

/** A job a module puts on the queue with data (`JobQueue.enqueue`). */
export interface OnDemandJobDefinition<Payload> extends JobDefinitionBase {
  readonly kind: "on_demand";
  /** Checked when the job is put on the queue and again when it runs. */
  readonly payload: z.ZodType<Payload>;
}

/** Reads a setting for a schedule, as stored when the schedule pass began. */
export type SettingReader = <Key extends SettingKey>(key: Key) => Promise<SettingValue<Key>>;

export interface SweepOptions {
  /** Rows claimed and handled in one transaction. */
  readonly batchSize: number;
  /** A run stops taking new batches after this long; the next run goes on. */
  readonly maxRunSeconds: number;
}

/** A job the worker starts by its schedule. It carries no data. */
export interface PeriodicJobDefinition extends JobDefinitionBase {
  readonly kind: "periodic";
  /**
   * A cron expression in Almaty time, derived from settings. Re-evaluated
   * while the worker runs, so a changed setting moves the schedule without
   * a restart. A run missed while no worker was up is made up once.
   */
  readonly schedule: (setting: SettingReader) => Promise<string> | string;
  /** Set for a deadline sweeper (`defineSweeperJob`). */
  readonly sweep?: SweepOptions;
}

export type JobDefinition = OnDemandJobDefinition<unknown> | PeriodicJobDefinition;

function checkBase(definition: JobDefinitionBase): void {
  const { name, timeoutSeconds, retry } = definition;
  if (!JOB_NAME.test(name) || name.endsWith(DEAD_LETTER_SUFFIX) || name.length > 100) {
    throw new Error(`Invalid job name "${name}": use <module>.<job> in lower case`);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error(`Job ${name}: timeoutSeconds must be a whole number between 1 and 3600`);
  }
  if (
    !Number.isInteger(retry.limit) ||
    retry.limit < 0 ||
    !Number.isInteger(retry.delaySeconds) ||
    retry.delaySeconds < 0
  ) {
    throw new Error(`Job ${name}: retry.limit and retry.delaySeconds must be whole numbers ≥ 0`);
  }
}

export function defineJob<Payload>(
  definition: Omit<OnDemandJobDefinition<Payload>, "kind">,
): OnDemandJobDefinition<Payload> {
  checkBase(definition);
  return Object.freeze({ ...definition, kind: "on_demand" as const });
}

export function definePeriodicJob(
  definition: Omit<PeriodicJobDefinition, "kind" | "sweep">,
): PeriodicJobDefinition {
  checkBase(definition);
  return Object.freeze({ ...definition, kind: "periodic" as const });
}

/**
 * A deadline sweeper (ARCHITECTURE 13.1): every minute, one run at a time,
 * claims due rows in batches and applies the transition (`Sweeper`).
 */
export function defineSweeperJob(definition: {
  name: string;
  batchSize?: number;
  maxRunSeconds?: number;
  timeoutSeconds?: number;
}): PeriodicJobDefinition {
  const timeoutSeconds = definition.timeoutSeconds ?? 120;
  const sweep = {
    batchSize: definition.batchSize ?? 500,
    maxRunSeconds: definition.maxRunSeconds ?? Math.floor(timeoutSeconds / 2),
  };
  if (!Number.isInteger(sweep.batchSize) || sweep.batchSize < 1 || sweep.batchSize > 10_000) {
    throw new Error(`Sweeper ${definition.name}: batchSize must be between 1 and 10000`);
  }
  if (sweep.maxRunSeconds < 1 || sweep.maxRunSeconds >= timeoutSeconds) {
    throw new Error(`Sweeper ${definition.name}: maxRunSeconds must be below timeoutSeconds`);
  }
  const job = definePeriodicJob({
    name: definition.name,
    timeoutSeconds,
    // The next run a minute later is the retry.
    retry: { limit: 0, delaySeconds: 0, backoff: false },
    singleton: true,
    schedule: () => EVERY_MINUTE,
  });
  return Object.freeze({ ...job, sweep: Object.freeze(sweep) });
}

export const EVERY_MINUTE = "* * * * *";

/** `HH:MM` every day, Almaty time. */
export function dailyAt(hour: number, minute = 0): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid hour ${String(hour)}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid minute ${String(minute)}`);
  }
  return `${String(minute)} ${String(hour)} * * *`;
}

export function deadLetterQueueName(name: string): string {
  return `${name}${DEAD_LETTER_SUFFIX}`;
}
