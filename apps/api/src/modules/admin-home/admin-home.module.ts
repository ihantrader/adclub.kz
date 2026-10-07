import { Module, type DynamicModule } from "@nestjs/common";
import { AdminHomeController } from "./admin-home.controller";
import { AdminHomeService } from "./admin-home.service";

/** The one instance of each module of the process the counters ask (their very rules). */
export interface AdminHomeModuleOptions {
  catalog: DynamicModule;
  compatibility: DynamicModule;
  signals: DynamicModule;
  suppliers: DynamicModule;
}

/**
 * The administrator's queue of attention, `GET /admin/home` (TASK-034,
 * ARCHITECTURE 4.52; SCREENS A-HOME). It owns no data: it asks the modules
 * that do.
 */
@Module({})
export class AdminHomeModule {
  static forRoot(options: AdminHomeModuleOptions): DynamicModule {
    return {
      module: AdminHomeModule,
      imports: [options.catalog, options.compatibility, options.signals, options.suppliers],
      controllers: [AdminHomeController],
      providers: [AdminHomeService],
    };
  }
}
