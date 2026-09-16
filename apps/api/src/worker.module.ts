import { Module } from "@nestjs/common";
import { ConfigModule, type AppConfig } from "./config";
import { DatabaseModule } from "./database";
import { RedisModule } from "./redis";
import { StorageModule } from "./storage";
import { JsonLoggerService } from "./common/logging";

/**
 * The worker process uses the same connection modules as the API
 * (ARCHITECTURE 3.4, TASK-002 requirement 2), just without any HTTP
 * surface. Background job processors (pg-boss) arrive in later tasks.
 */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig) {
    return {
      module: WorkerModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, RedisModule, StorageModule],
      providers: [JsonLoggerService],
    };
  }
}
