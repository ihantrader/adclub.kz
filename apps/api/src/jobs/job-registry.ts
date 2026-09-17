import { Inject, Injectable } from "@nestjs/common";
import type { JobDefinition, OnDemandJobDefinition, PeriodicJobDefinition } from "./job-definition";
import type { JobHandler, JobRunContext, JobRunOutcome, PeriodicJobHandler } from "./job-handler";
import { SweepRunner, type Sweeper } from "./sweeper";

export interface RegisteredJob {
  definition: JobDefinition;
  /** Runs one job; the payload is already checked against the declaration. */
  run(payload: unknown, context: JobRunContext): Promise<void | JobRunOutcome>;
}

/**
 * Implementations of declared jobs in this process. Modules register
 * theirs in `onModuleInit`; the worker (`JobRunner`) starts consuming once
 * the application has started and refuses to start if a declared job has
 * no implementation or an implementation has no declaration.
 */
@Injectable()
export class JobRegistry {
  private readonly jobs = new Map<string, RegisteredJob>();

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SweepRunner) private readonly sweeps: SweepRunner) {}

  handle<Payload>(definition: OnDemandJobDefinition<Payload>, handler: JobHandler<Payload>): void {
    this.add({
      definition: definition as OnDemandJobDefinition<unknown>,
      run: (payload, context) => handler.run(payload as Payload, context),
    });
  }

  handlePeriodic(definition: PeriodicJobDefinition, handler: PeriodicJobHandler): void {
    if (definition.sweep) {
      throw new Error(`Job ${definition.name} is a sweeper: register it with sweep()`);
    }
    this.add({ definition, run: (_payload, context) => handler.run(context) });
  }

  sweep<Context>(definition: PeriodicJobDefinition, sweeper: Sweeper<Context>): void {
    if (!definition.sweep) {
      throw new Error(`Job ${definition.name} is not a sweeper (defineSweeperJob)`);
    }
    this.add({
      definition,
      run: async (_payload, context) => {
        const result = await this.sweeps.run(definition, sweeper, context);
        // A sweep that claimed nothing is a run with nothing to do.
        return { worked: result.processed > 0 || result.failed > 0 };
      },
    });
  }

  get(name: string): RegisteredJob | undefined {
    return this.jobs.get(name);
  }

  all(): RegisteredJob[] {
    return [...this.jobs.values()];
  }

  private add(job: RegisteredJob): void {
    if (this.jobs.has(job.definition.name)) {
      throw new Error(`Job ${job.definition.name} is registered twice`);
    }
    this.jobs.set(job.definition.name, job);
  }
}
