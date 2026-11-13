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
import { MessagingJobsModule, MessagingModule } from "./modules/messaging";
import { NotificationJobsModule, NotificationsModule } from "./modules/notifications";
import { AuditModule } from "./modules/audit";
import { CatalogJobsModule } from "./modules/catalog";
import { VehicleJobsModule } from "./modules/vehicles";
import { SupplierJobsModule } from "./modules/suppliers";
import { OrderJobsModule } from "./modules/orders";
import { SearchIndexJobsModule } from "./modules/search-index";
import { PriceImportJobsModule } from "./modules/price-imports";
import { ReviewJobsModule } from "./modules/reviews";
import { AssistantJobsModule } from "./modules/assistant";
import { RatingJobsModule } from "./modules/ratings";
import { BillingJobsModule } from "./modules/billing";
import { CatalogModule } from "./modules/catalog";
import { CompatibilityModule } from "./modules/compatibility";
import { ClubAccessModule } from "./modules/club-access";
import { ShowcaseModule } from "./modules/showcase";
import { VehiclesModule } from "./modules/vehicles";
import { MaintenanceModule } from "./modules/maintenance";
import { ReminderJobsModule } from "./modules/reminders";
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
    // The reminders (TASK-069) read through the client catalog, the one compatibility
    // calculation and the maintenance plans — the same modules the API has, without routes.
    const catalog = CatalogModule.forRoot({ http: false });
    const compatibility = CompatibilityModule.forRoot({ http: false, catalog });
    const clubAccess = ClubAccessModule.forRoot({ http: false });
    const showcase = ShowcaseModule.forRoot({ http: false, catalog, compatibility, clubAccess });
    const vehicles = VehiclesModule.forRoot({ http: false });
    const maintenance = MaintenanceModule.forRoot({ http: false, catalog, showcase, vehicles });
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
        MessagingModule.forRoot(config, { http: false }),
        NotificationsModule.forRoot(config, { http: false }),
        JobsModule.forRoot({
          role: "worker",
          catalog: backgroundJobCatalog(config),
          tuning: options.jobs,
        }),
        IdentityJobsModule,
        CatalogJobsModule,
        VehicleJobsModule,
        MessagingJobsModule,
        NotificationJobsModule,
        SupplierJobsModule,
        OrderJobsModule,
        SearchIndexJobsModule,
        PriceImportJobsModule,
        ReviewJobsModule,
        AssistantJobsModule,
        RatingJobsModule,
        BillingJobsModule.forRoot(config),
        ReminderJobsModule.forRoot({ compatibility, showcase, maintenance }),
        ...(hasDevJobs(config) ? [DevJobsModule] : []),
      ],
      providers: [JsonLoggerService],
    };
  }
}
