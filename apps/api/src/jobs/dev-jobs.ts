import { Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { defineJob } from "./job-definition";
import type { JobHandler } from "./job-handler";
import { JobRegistry } from "./job-registry";

/**
 * Development and tests only (TASK-008): a job that always fails, to see
 * retries and the dead letter queue work end to end
 * (`operator dev:jobs:fail`). Not in the catalog of staging or production.
 */
export const devAlwaysFailingJob = defineJob({
  name: "dev.always-fails",
  payload: z.object({ note: z.string().max(200) }),
  timeoutSeconds: 30,
  retry: { limit: 2, delaySeconds: 1, backoff: false },
  singleton: false,
});

export const devJobCatalog = [devAlwaysFailingJob];

@Injectable()
class DevAlwaysFailingJob implements JobHandler<{ note: string }> {
  run(): Promise<void> {
    return Promise.reject(new Error("This development job always fails"));
  }
}

@Module({ providers: [DevAlwaysFailingJob] })
export class DevJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(DevAlwaysFailingJob) private readonly failing: DevAlwaysFailingJob,
  ) {}

  onModuleInit(): void {
    this.registry.handle(devAlwaysFailingJob, this.failing);
  }
}
