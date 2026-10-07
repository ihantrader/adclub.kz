import { Module, type DynamicModule } from "@nestjs/common";
import { CompatibilityListRule } from "./compatibility-list-rule";
import { CompatibilityController } from "./compatibility.controller";
import { CompatibilityEvaluator } from "./compatibility-evaluator";
import { CompatibilityProposalsService } from "./compatibility-proposals.service";
import { CompatibilityRecordsService } from "./compatibility-records.service";
import { DevCompatibilitySeed } from "./dev-compatibility-seed";

export interface CompatibilityModuleOptions {
  /** Serve the admin, cabinet and client routes (the API process only). */
  http: boolean;
  /**
   * The catalog module of the application, the very same instance: this
   * module gives its items list the rule «без совместимости» (TASK-035).
   * Left out where nothing lists items (the operator command).
   */
  catalog?: DynamicModule;
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
      imports: options.catalog ? [options.catalog] : [],
      controllers: options.http ? [CompatibilityController] : [],
      providers: [
        CompatibilityEvaluator,
        CompatibilityRecordsService,
        CompatibilityProposalsService,
        DevCompatibilitySeed,
        ...(options.catalog ? [CompatibilityListRule] : []),
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
