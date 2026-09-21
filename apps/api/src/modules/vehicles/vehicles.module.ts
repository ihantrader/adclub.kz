import { Module, type DynamicModule, type OnModuleInit, Inject } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import { DevVehicleSeed } from "./dev-vehicle-seed";
import { analyzeImportJob, applyImportJob, expireImportsJob } from "./import/import-jobs";
import { VehicleImportController } from "./import/vehicle-import.controller";
import {
  VehicleImportAnalyzer,
  VehicleImportApplier,
  VehicleImportExpiry,
} from "./import/vehicle-import-runner";
import { VehicleImportService } from "./import/vehicle-import.service";
import { VehicleAdminController } from "./vehicle-admin.controller";
import { VehicleHierarchyService } from "./vehicle-hierarchy.service";
import { VehicleModificationsService } from "./vehicle-modifications.service";
import { VehicleOptionsService } from "./vehicle-options.service";
import { VehicleReadService } from "./vehicle-read.service";
import { VehiclesController } from "./vehicles.controller";

export interface VehiclesModuleOptions {
  /** Serve the admin and client routes (the API process only). */
  http: boolean;
}

/**
 * The vehicle catalog (ARCHITECTURE 5.3, 4.24; TASK-014): makes, models,
 * generations, modifications, the reference lists and engines they are
 * made of, the admin routes that keep them, imports from a file, and the
 * client routes for choosing a car step by step.
 */
@Module({})
export class VehiclesModule {
  static forRoot(options: VehiclesModuleOptions): DynamicModule {
    return {
      module: VehiclesModule,
      controllers: options.http
        ? [VehiclesController, VehicleAdminController, VehicleImportController]
        : [],
      providers: [
        VehicleOptionsService,
        VehicleHierarchyService,
        VehicleModificationsService,
        VehicleReadService,
        VehicleImportService,
        DevVehicleSeed,
      ],
      exports: [
        VehicleOptionsService,
        VehicleHierarchyService,
        VehicleModificationsService,
        VehicleReadService,
        VehicleImportService,
        DevVehicleSeed,
      ],
    };
  }
}

/** The vehicle catalog's background jobs, for the worker process. */
@Module({
  providers: [VehicleImportAnalyzer, VehicleImportApplier, VehicleImportExpiry],
})
export class VehicleJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(VehicleImportAnalyzer) private readonly analyzer: VehicleImportAnalyzer,
    @Inject(VehicleImportApplier) private readonly applier: VehicleImportApplier,
    @Inject(VehicleImportExpiry) private readonly expiry: VehicleImportExpiry,
  ) {}

  onModuleInit(): void {
    this.registry.handle(analyzeImportJob, this.analyzer);
    this.registry.handle(applyImportJob, this.applier);
    this.registry.handlePeriodic(expireImportsJob, this.expiry);
  }
}
