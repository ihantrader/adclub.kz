import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule, type AppConfig } from "./config";
import { DatabaseModule } from "./database";
import { RedisModule } from "./redis";
import { StorageModule } from "./storage";
import { HealthModule } from "./health/health.module";
import { IdentityModule } from "./modules/identity";
import { HttpExceptionFilter, NotFoundModule } from "./common/errors";
import { JsonLoggerService, LoggingInterceptor, RequestIdMiddleware } from "./common/logging";

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
        IdentityModule,
        // Must stay last: its catch-all route would otherwise shadow
        // every route declared above (see NotFoundModule).
        NotFoundModule,
      ],
      providers: [
        JsonLoggerService,
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
