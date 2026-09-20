import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import type { AppConfig } from "../../config";
import { Metrics } from "../../observability";
import { AiGateway } from "./ai-gateway";
import {
  AI_SERVICE_OPTIONS,
  AiService,
  defaultAiServiceOptions,
  type AiServiceOptions,
} from "./ai.service";
import { OpenRouterAiGateway } from "./openrouter-ai-gateway";
import { TestAiGateway } from "./test-ai-gateway";

/**
 * The AI budget and spend as metrics, sampled from `ai_job` when metrics
 * are scraped (the worker makes the calls, the API serves the scrape).
 */
@Injectable()
export class AiMetrics implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectAi(async () => {
      const status = await this.ai.status();
      this.metrics.setAiSpend(status.spentUsd);
      this.metrics.setAiBudget(status.budgetUsd);
      for (const row of status.today) {
        this.metrics.setAiCalls(row.kind, row.status, row.calls);
      }
    });
  }
}

export interface AiModuleOptions {
  /** Sample AI spend for metrics (the process that serves them). */
  metrics?: boolean;
  /** Tests shorten the time limit of a call. */
  service?: Partial<AiServiceOptions>;
}

/**
 * AI behind the internal interface (ARCHITECTURE 9.6, 4.19, 4.20;
 * TASK-012, TASK-053): the provider is OpenRouter (D-055), chosen by
 * configuration (`AI_PROVIDER`; without a key the test one), and
 * `AiService` records and limits every call. Global: modules use
 * `AiService` without importing this one.
 */
@Global()
@Module({})
export class AiModule {
  static forRoot(config: AppConfig, options: AiModuleOptions = {}): DynamicModule {
    const gateway =
      config.ai.provider === "openrouter" && config.ai.openRouterApiKey
        ? [
            {
              provide: AiGateway,
              useFactory: () =>
                new OpenRouterAiGateway(config.ai.openRouterApiKey!, config.ai.openRouterBaseUrl),
            },
          ]
        : [
            {
              provide: TestAiGateway,
              useFactory: () => {
                const gateway = new TestAiGateway();
                gateway.mode = config.ai.testMode;
                return gateway;
              },
            },
            { provide: AiGateway, useExisting: TestAiGateway },
          ];
    return {
      module: AiModule,
      providers: [
        ...gateway,
        {
          provide: AI_SERVICE_OPTIONS,
          useValue: { ...defaultAiServiceOptions, ...options.service },
        },
        AiService,
        ...(options.metrics ? [AiMetrics] : []),
      ],
      exports: [AiGateway, AiService],
    };
  }
}
