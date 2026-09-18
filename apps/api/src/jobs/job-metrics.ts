import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Metrics } from "../observability";
import { JobAdmin } from "./job-admin.service";

/**
 * Queue metrics (ARCHITECTURE 15.3): depth, failures, dead letters and how
 * long ago each periodic job last succeeded. Sampled when metrics are
 * scraped, and from the database rather than from memory — the jobs run in
 * the worker while `GET /metrics` is served by the API, and both see the
 * same queue.
 */
@Injectable()
export class JobMetrics implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JobAdmin) private readonly jobs: JobAdmin,
  ) {}

  onModuleInit(): void {
    this.metrics.collectJobs(() => this.sample());
  }

  private async sample(): Promise<void> {
    const now = Date.now();
    for (const job of await this.jobs.status()) {
      this.metrics.setJobQueueDepth(job.job, "waiting", job.waiting);
      this.metrics.setJobQueueDepth(job.job, "retrying", job.retrying);
      this.metrics.setJobQueueDepth(job.job, "running", job.running);
      this.metrics.setJobFailed(job.job, job.failed);
      this.metrics.setJobDead(job.job, job.dead ?? 0);
      if (job.kind === "periodic" && job.lastSucceededAt) {
        this.metrics.setPeriodicJobSuccessAge(
          job.job,
          Math.max(0, Math.round((now - new Date(job.lastSucceededAt).getTime()) / 1000)),
        );
      }
    }
  }
}
