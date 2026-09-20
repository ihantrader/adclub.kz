import { Injectable } from "@nestjs/common";
import { MetricsRegistry, type MetricCollector } from "./metrics-registry";

/** Seconds; the spread an HTTP request is expected to fall in. */
const HTTP_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * The metrics the platform publishes (ARCHITECTURE 15.3, 4.13, requirement
 * 4 of TASK-009): API latency and response codes per route, the background
 * queue (depth, failures, dead letters), sign-in limits and code delivery,
 * and the state of the dependencies behind `/ready`. Nothing here carries
 * personal data: labels are route templates from the contract, job names,
 * channels, limit names and outcomes.
 *
 * Both processes count; only the API serves them (`GET /metrics`), so what
 * the worker does is measured from the database it writes to (queue depth,
 * dead letters and the last runs of periodic jobs) rather than from its
 * memory.
 */
@Injectable()
export class Metrics {
  readonly registry = new MetricsRegistry();

  private readonly httpDuration = this.registry.histogram(
    "adclub_http_request_duration_seconds",
    "Duration of an HTTP request by route, method and status",
    HTTP_BUCKETS,
  );
  private readonly httpResponses = this.registry.counter(
    "adclub_http_responses_total",
    "HTTP responses by route, method and status",
  );
  private readonly jobQueueDepth = this.registry.gauge(
    "adclub_job_queue_depth",
    "Jobs on a queue by state (created, retry, active)",
  );
  private readonly jobFailures = this.registry.gauge(
    "adclub_job_failed",
    "Jobs that ended in failure, by job (from the queue's own bookkeeping)",
  );
  private readonly jobDead = this.registry.gauge(
    "adclub_job_dead",
    "Jobs waiting in a dead letter queue, by job",
  );
  private readonly periodicJobState = this.registry.gauge(
    "adclub_periodic_job_last_success_age_seconds",
    "Seconds since a periodic job last succeeded",
  );
  private readonly loginCodeLimits = this.registry.counter(
    "adclub_login_code_rate_limit_hits_total",
    "Sign-in limits that refused a request, by limit",
  );
  private readonly loginCodeDeliveries = this.registry.counter(
    "adclub_login_code_deliveries_total",
    "Login code deliveries by channel and outcome (sent, failed)",
  );
  private readonly aiSpend = this.registry.gauge(
    "adclub_ai_spend_today_usd",
    "Spend on AI calls since the start of the Almaty day, USD (from ai_job)",
  );
  private readonly aiBudget = this.registry.gauge(
    "adclub_ai_daily_budget_usd",
    "The daily AI budget, USD (setting ai_daily_budget_usd); spend at or above it stops new calls",
  );
  private readonly aiCalls = this.registry.gauge(
    "adclub_ai_calls_today",
    "AI calls since the start of the Almaty day by kind and status (from ai_job)",
  );
  private readonly translationTasks = this.registry.gauge(
    "adclub_translation_tasks",
    "Automatic translations waiting (pending) or refused for good (failed), by state",
  );
  private readonly dependencyUp = this.registry.gauge(
    "adclub_dependency_up",
    "1 when a dependency answered the last /ready check, 0 when it did not",
  );
  private readonly monitoringEvents = this.registry.counter(
    "adclub_monitoring_events_total",
    "Events offered to error monitoring by outcome (sent, failed, dropped, disabled)",
  );
  private readonly sanitizerFailures = this.registry.counter(
    "adclub_sanitizer_failures_total",
    "Times the sanitizer could not clean a value, so nothing was sent",
  );

  observeHttpRequest(route: string, method: string, status: number, durationMs: number): void {
    const labels = { route, method, status };
    this.httpDuration.observe(labels, durationMs / 1000);
    this.httpResponses.increment(labels);
  }

  setJobQueueDepth(job: string, state: string, count: number): void {
    this.jobQueueDepth.set({ job, state }, count);
  }

  setJobFailed(job: string, count: number): void {
    this.jobFailures.set({ job }, count);
  }

  setJobDead(job: string, count: number): void {
    this.jobDead.set({ job }, count);
  }

  setPeriodicJobSuccessAge(job: string, seconds: number): void {
    this.periodicJobState.set({ job }, seconds);
  }

  countRateLimitHit(limit: string): void {
    this.loginCodeLimits.increment({ limit });
  }

  countLoginCodeDelivery(channel: string, outcome: "sent" | "failed"): void {
    this.loginCodeDeliveries.increment({ channel, outcome });
  }

  setAiSpend(usd: number): void {
    this.aiSpend.set({}, usd);
  }

  setAiBudget(usd: number): void {
    this.aiBudget.set({}, usd);
  }

  setAiCalls(kind: string, status: string, count: number): void {
    this.aiCalls.set({ kind, status }, count);
  }

  setTranslationTasks(state: string, count: number): void {
    this.translationTasks.set({ state }, count);
  }

  setDependencyUp(dependency: string, up: boolean): void {
    this.dependencyUp.set({ dependency }, up ? 1 : 0);
  }

  countMonitoringEvent(outcome: "sent" | "failed" | "dropped" | "disabled"): void {
    this.monitoringEvents.increment({ outcome });
  }

  countSanitizerFailure(): void {
    this.sanitizerFailures.increment();
  }

  /**
   * The queue metrics, sampled when metrics are scraped (from the
   * database: the worker runs the jobs, the API serves the scrape). If the
   * sample fails, they are absent from that scrape.
   */
  collectJobs(collector: MetricCollector): void {
    this.registry.collect("jobs", collector, [
      this.jobQueueDepth,
      this.jobFailures,
      this.jobDead,
      this.periodicJobState,
    ]);
  }

  /**
   * AI spend and the daily budget, sampled when metrics are scraped (from
   * the database, like the jobs: the worker makes the calls, the API serves
   * the scrape).
   */
  collectAi(collector: MetricCollector): void {
    this.registry.collect("ai", collector, [this.aiSpend, this.aiBudget, this.aiCalls]);
  }

  /** The automatic translation queue, sampled like the AI spend. */
  collectTranslation(collector: MetricCollector): void {
    this.registry.collect("translation", collector, [this.translationTasks]);
  }

  render(): Promise<string> {
    return this.registry.render();
  }
}
