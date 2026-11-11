import { Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import { AssistantAdminService } from "./assistant-admin.service";
import { AssistantAnswers } from "./assistant-answer";
import { AssistantLimitsService } from "./assistant-limits";
import { AssistantPipeline } from "./assistant-pipeline";
import { anonymizeAssistantMessagesJob, AssistantRetention } from "./assistant-retention";
import { AssistantTools } from "./assistant-tools";
import { AdminAssistantController, AssistantController } from "./assistant.controller";
import { AssistantService } from "./assistant.service";
import { AssistantEval } from "./eval/assistant-eval";

export interface AssistantModuleOptions {
  /** Serve the routes (the API process only). */
  http: boolean;
  /**
   * The very instances of the application's modules the tools run through:
   * the catalog (its tree and filters), the client catalog (the search, the
   * lists and the card — what the person sees), the maintenance plans and
   * the signals (the day's AI budget spent).
   */
  catalog: DynamicModule;
  showcase: DynamicModule;
  maintenance: DynamicModule;
  /** Not needed for `pipelineOnly`. */
  signals?: DynamicModule;
  /**
   * Only the turn itself and the model comparison (`ai:eval:assistant`, the
   * operator command): no routes, limits or storage — so no Redis.
   */
  pipelineOnly?: boolean;
}

/**
 * The AI Pilot assistant (TASK-062; PRODUCT 8.3; ARCHITECTURE 11, 4.85): a
 * turn of a dialog with tools over the catalog, grounding of the answer,
 * the limits, the dialogs and the complaints about answers. The texts are
 * made impersonal in the worker (`AssistantJobsModule`).
 */
@Module({})
export class AssistantModule {
  static forRoot(options: AssistantModuleOptions): DynamicModule {
    if (options.pipelineOnly) {
      return {
        module: AssistantModule,
        imports: [options.catalog, options.showcase, options.maintenance],
        providers: [AssistantTools, AssistantAnswers, AssistantPipeline, AssistantEval],
        exports: [AssistantPipeline, AssistantEval],
      };
    }
    if (!options.signals) throw new Error("AssistantModule needs the signals module");
    return {
      module: AssistantModule,
      imports: [options.catalog, options.showcase, options.maintenance, options.signals],
      controllers: options.http ? [AssistantController, AdminAssistantController] : [],
      providers: [
        AssistantTools,
        AssistantAnswers,
        AssistantPipeline,
        AssistantLimitsService,
        AssistantService,
        AssistantAdminService,
      ],
      exports: [AssistantService, AssistantAdminService, AssistantPipeline],
    };
  }
}

/** The worker's part: the texts of old dialogs made impersonal. */
@Module({ providers: [AssistantRetention] })
export class AssistantJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(AssistantRetention) private readonly retention: AssistantRetention,
  ) {}

  onModuleInit(): void {
    this.registry.sweep(anonymizeAssistantMessagesJob, this.retention);
  }
}
