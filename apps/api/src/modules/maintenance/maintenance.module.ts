import { Module, type DynamicModule } from "@nestjs/common";
import { DevMaintenanceSeed } from "./dev-maintenance-seed";
import { MaintenanceAnswers } from "./maintenance-answers.service";
import { MaintenanceController } from "./maintenance.controller";
import { MaintenanceDrafts } from "./maintenance-draft.service";
import { MaintenancePlansService } from "./maintenance-plans.service";

export interface MaintenanceModuleOptions {
  /** Serve the client and admin routes (the API process only). */
  http: boolean;
  /**
   * The very instances of the application's modules it reads through: the
   * catalog (titles and their automatic translation) and the client catalog
   * (what is sold by a rule — the one list of a subcategory).
   */
  catalog: DynamicModule;
  showcase: DynamicModule;
}

/**
 * Maintenance plans as data (TASK-061; ARCHITECTURE 4.84, 11.3): plans of a
 * make, a model, a generation or an engine kept by the administrator, the
 * first drafts made by AI, and what a car is due with what the platform
 * sells for it.
 */
@Module({})
export class MaintenanceModule {
  static forRoot(options: MaintenanceModuleOptions): DynamicModule {
    return {
      module: MaintenanceModule,
      imports: [options.catalog, options.showcase],
      controllers: options.http ? [MaintenanceController] : [],
      providers: [
        MaintenancePlansService,
        MaintenanceDrafts,
        MaintenanceAnswers,
        DevMaintenanceSeed,
      ],
      exports: [MaintenancePlansService, MaintenanceDrafts, MaintenanceAnswers, DevMaintenanceSeed],
    };
  }
}
