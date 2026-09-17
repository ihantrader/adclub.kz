import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../config";
import { ErrorReporter } from "./error-reporter.service";
import { MetricsController } from "./metrics.controller";
import { Metrics } from "./metrics.service";

export interface ObservabilityModuleOptions {
  /** Serve `GET /metrics` (the API process, and only when metrics are on). */
  http: boolean;
}

/**
 * Observability (ARCHITECTURE 15.3, 4.13): the sanitizer every outgoing
 * text goes through, error monitoring behind it, and the metrics both
 * processes count. Global — any module measures or reports without
 * importing this one.
 */
@Global()
@Module({})
export class ObservabilityModule {
  static forRoot(config: AppConfig, options: ObservabilityModuleOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: options.http && config.metrics.enabled ? [MetricsController] : [],
      providers: [Metrics, ErrorReporter],
      exports: [Metrics, ErrorReporter],
    };
  }
}
