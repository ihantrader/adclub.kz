import { Module } from "@nestjs/common";
import { ConfigModule, type AppConfig } from "./config";
import { DatabaseModule } from "./database";
import { RedisModule } from "./redis";
import { StorageModule } from "./storage";
import { JsonLoggerService } from "./common/logging";
import { ObservabilityModule } from "./observability";
import { SettingsModule, type SettingsCacheOptions } from "./modules/settings";
import { IdentityJobsModule } from "./modules/identity";
import { AiModule, type AiServiceOptions } from "./modules/ai";
import { AuditModule } from "./modules/audit";
import { CatalogJobsModule } from "./modules/catalog";
import { VehicleJobsModule } from "./modules/vehicles";
import { SupplierJobsModule } from "./modules/suppliers";
import { DevJobsModule, JobsModule, type JobsTuning } from "./jobs";
import { backgroundJobCatalog, hasDevJobs } from "./background-jobs";

/**
 * The worker process uses the same connection modules as the API
 * (ARCHITECTURE 3.4, TASK-002 requirement 2), just without any HTTP
 * surface. It runs the background jobs (pg-boss, ARCHITECTURE 13.1, 4.12):
 * every module with jobs contributes a jobs module registering their
 * implementations; thresholds come from `AppSettings` (TASK-007).
 */
@Module({})
export class WorkerModule {
  static forRoot(
    config: AppConfig,
    options: {
      settingsCache?: Partial<SettingsCacheOptions>;
      /** Tests shorten the queue timings. */
      jobs?: Partial<JobsTuning>;
      /** Tests shorten the time limit of an AI call. */
      ai?: Partial<AiServiceOptions>;
    } = {},
  ) {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot(config),
        ObservabilityModule.forRoot(config, { http: false }),
        DatabaseModule,
        RedisModule,
        StorageModule,
        AuditModule.forRoot({ http: false }),
        SettingsModule.forRoot({ http: false, cache: options.settingsCache }),
        AiModule.forRoot(config, { service: options.ai }),
        JobsModule.forRoot({
          role: "worker",
          catalog: backgroundJobCatalog(config),
          tuning: options.jobs,
        }),
        IdentityJobsModule,
        CatalogJobsModule,
        VehicleJobsModule,
        SupplierJobsModule,
        ...(hasDevJobs(config) ? [DevJobsModule] : []),
      ],
      providers: [JsonLoggerService],
    };
  }
}
