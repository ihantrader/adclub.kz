import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule, type AppConfig } from "./config";
import { DatabaseModule } from "./database";
import { RedisModule } from "./redis";
import { StorageModule } from "./storage";
import { HealthModule } from "./health/health.module";
import { ClientPolicyModule } from "./client-policy";
import { OpenApiModule } from "./openapi";
import { IdentityModule } from "./modules/identity";
import { AiModule } from "./modules/ai";
import { AuditModule } from "./modules/audit";
import { CatalogModule } from "./modules/catalog";
import { VehiclesModule } from "./modules/vehicles";
import { CompatibilityModule } from "./modules/compatibility";
import { SuppliersModule } from "./modules/suppliers";
import { SettingsModule, type SettingsCacheOptions } from "./modules/settings";
import { JobsModule, type JobsTuning } from "./jobs";
import { backgroundJobCatalog } from "./background-jobs";
import { HttpExceptionFilter, NotFoundModule } from "./common/errors";
import { JsonBodyMiddleware, OriginPolicyMiddleware, UploadBodyMiddleware } from "./common/http";
import { AccessLogMiddleware, JsonLoggerService, RequestIdMiddleware } from "./common/logging";
import { ObservabilityModule } from "./observability";

@Module({})
export class AppModule implements NestModule {
  /**
   * `AppModule` is built from an already-validated `AppConfig` (see
   * `loadConfig` in `main.ts`) rather than reading `process.env` itself,
   * so config validation happens once, before Nest's DI container exists,
   * and fails with a plain readable message instead of a DI error.
   */
  static forRoot(
    config: AppConfig,
    options: {
      settingsCache?: Partial<SettingsCacheOptions>;
      jobs?: Partial<JobsTuning>;
    } = {},
  ) {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        // Before everything that measures, reports or logs through it.
        ObservabilityModule.forRoot(config, { http: true }),
        DatabaseModule,
        RedisModule,
        StorageModule,
        AuditModule.forRoot({ http: true }),
        SettingsModule.forRoot({ http: true, cache: options.settingsCache }),
        AiModule.forRoot(config, { metrics: config.metrics.enabled }),
        // The API puts jobs on the queue; the worker runs them.
        JobsModule.forRoot({
          role: "producer",
          catalog: backgroundJobCatalog(config),
          // The API serves GET /metrics, so it samples the queue for them.
          metrics: config.metrics.enabled,
          tuning: options.jobs,
        }),
        HealthModule,
        ClientPolicyModule,
        // API docs for development only (TASK-003); production serves the
        // contract routes alone.
        ...(config.nodeEnv === "production" ? [] : [OpenApiModule]),
        IdentityModule.forRoot(config),
        CatalogModule.forRoot({ http: true, metrics: config.metrics.enabled }),
        VehiclesModule.forRoot({ http: true }),
        CompatibilityModule.forRoot({ http: true }),
        SuppliersModule.forRoot({ http: true, devOutbox: config.loginCode.devOutbox }),
        // Must stay last: its catch-all route would otherwise shadow
        // every route declared above (see NotFoundModule).
        NotFoundModule,
      ],
      providers: [JsonLoggerService, { provide: APP_FILTER, useClass: HttpExceptionFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Order matters: the access log line needs the request id context, and
    // a request refused for its origin or its body type should still be
    // logged. `UploadBodyMiddleware` comes after the body-type check and
    // touches only the routes that take a file (TASK-013).
    consumer
      .apply(
        RequestIdMiddleware,
        AccessLogMiddleware,
        OriginPolicyMiddleware,
        JsonBodyMiddleware,
        UploadBodyMiddleware,
      )
      .forRoutes("*");
  }
}
