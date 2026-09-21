import { Module, type DynamicModule } from "@nestjs/common";
import { CompatibilityController } from "./compatibility.controller";
import { CompatibilityEvaluator } from "./compatibility-evaluator";
import { CompatibilityProposalsService } from "./compatibility-proposals.service";
import { CompatibilityRecordsService } from "./compatibility-records.service";
import { DevCompatibilitySeed } from "./dev-compatibility-seed";

export interface CompatibilityModuleOptions {
  /** Serve the admin, cabinet and client routes (the API process only). */
  http: boolean;
}

/**
 * Compatibility of catalog items with cars (ARCHITECTURE 5.3, 4.25;
 * TASK-015): approved records kept by the administrator, proposals of
 * suppliers and their moderation, and the one calculation of the result
 * for a car (`CompatibilityEvaluator`) every consumer goes through.
 */
@Module({})
export class CompatibilityModule {
  static forRoot(options: CompatibilityModuleOptions): DynamicModule {
    return {
      module: CompatibilityModule,
      controllers: options.http ? [CompatibilityController] : [],
      providers: [
        CompatibilityEvaluator,
        CompatibilityRecordsService,
        CompatibilityProposalsService,
        DevCompatibilitySeed,
      ],
      exports: [
        CompatibilityEvaluator,
        CompatibilityRecordsService,
        CompatibilityProposalsService,
        DevCompatibilitySeed,
      ],
    };
  }
}
