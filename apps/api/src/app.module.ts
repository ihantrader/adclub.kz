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
import { HttpExceptionFilter, NotFoundModule } from "./common/errors";
import { OriginPolicyMiddleware } from "./common/http";
import { AccessLogMiddleware, JsonLoggerService, RequestIdMiddleware } from "./common/logging";

@Module({})
export class AppModule implements NestModule {
  /**
   * `AppModule` is built from an already-validated `AppConfig` (see
   * `loadConfig` in `main.ts`) rather than reading `process.env` itself,
   * so config validation happens once, before Nest's DI container exists,
   * and fails with a plain readable message instead of a DI error.
   */
  static forRoot(config: AppConfig) {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        RedisModule,
        StorageModule,
        HealthModule,
        ClientPolicyModule,
        // API docs for development only (TASK-003); production serves the
        // contract routes alone.
        ...(config.nodeEnv === "production" ? [] : [OpenApiModule]),
        IdentityModule.forRoot(config),
        // Must stay last: its catch-all route would otherwise shadow
        // every route declared above (see NotFoundModule).
        NotFoundModule,
      ],
      providers: [JsonLoggerService, { provide: APP_FILTER, useClass: HttpExceptionFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Order matters: the access log line needs the request id context, and
    // a request refused for its origin should still be logged.
    consumer.apply(RequestIdMiddleware, AccessLogMiddleware, OriginPolicyMiddleware).forRoutes("*");
  }
}
