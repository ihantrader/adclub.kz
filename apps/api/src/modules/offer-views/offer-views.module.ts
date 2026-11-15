import {
  Controller,
  Inject,
  Injectable,
  Module,
  Param,
  Query,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import {
  adminSupplierViewsQuerySchema,
  apiRoutes,
  supplierAdminPathSchema,
  type AdminSupplierViewsQuery,
  type AdminSupplierViewsResponse,
  type SupplierAdminPath,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import {
  dailyAt,
  definePeriodicJob,
  JobRegistry,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { AccountDirectory, SessionRoute } from "../identity";
import { AdminSignals } from "../signals";
import { OfferViewsService } from "./offer-views.service";

/**
 * `offers.views-signal` (TASK-070; ARCHITECTURE 13.2, 4.88): every day at
 * 05:10 Almaty time (after the ratings at 04:40) — the raw views past
 * `offer_view_retention_days` go, and the signal «Просмотров много, заявок
 * мало» is judged over the whole days of the window. `operator jobs:run
 * offers.views-signal` — now.
 */
export const viewsSignalJob = definePeriodicJob({
  name: "offers.views-signal",
  timeoutSeconds: 900,
  // The next day is the retry; `jobs:run` — at once.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => dailyAt(5, 10),
});

export const offerViewJobCatalog = [viewsSignalJob];

/** A-SUP-03 «Просмотры и заявки» (context `admin`). */
@Controller()
export class AdminOfferViewsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OfferViewsService) private readonly views: OfferViewsService) {}

  @SessionRoute(apiRoutes.getAdminSupplierViews)
  async supplierViews(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
    @Query(new ZodValidationPipe(adminSupplierViewsQuerySchema)) query: AdminSupplierViewsQuery,
  ): Promise<AdminSupplierViewsResponse> {
    return { views: await this.views.adminView(params.supplierId, query) };
  }
}

export interface OfferViewsModuleOptions {
  /** The signals module of the application, the very same instance. */
  signals: DynamicModule;
}

/** The API's part: the admin view of the views (the recorder — `OfferViewsRecorderModule`). */
@Module({})
export class OfferViewsModule {
  static forRoot(options: OfferViewsModuleOptions): DynamicModule {
    return {
      module: OfferViewsModule,
      imports: [options.signals],
      controllers: [AdminOfferViewsController],
      providers: [OfferViewsService],
      exports: [OfferViewsService],
    };
  }
}

/** `offers.views-signal`. */
@Injectable()
export class ViewsSignalRunner implements PeriodicJobHandler {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OfferViewsService) private readonly views: OfferViewsService) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    const { removed, raised, closed } = await this.views.run(context.signal);
    return { worked: removed + raised + closed > 0 };
  }
}

/** The worker's part: the daily signal and the cleanup of the raw views. */
@Module({
  providers: [AdminSignals, AccountDirectory, OfferViewsService, ViewsSignalRunner],
})
export class OfferViewJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(ViewsSignalRunner) private readonly runner: ViewsSignalRunner,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(viewsSignalJob, this.runner);
  }
}
