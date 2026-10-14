import {
  Controller,
  Inject,
  Injectable,
  Module,
  Param,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import {
  apiRoutes,
  supplierAdminPathSchema,
  type AdminSupplierRatingResponse,
  type SupplierAdminPath,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { JobRegistry } from "../../jobs";
import { AccountDirectory, SessionRoute } from "../identity";
import { AdminSignals } from "../signals";
import { SupplierListCounts } from "../suppliers";
import { recomputeSupplierRatingJob, reconcileRatingsJob } from "./rating-jobs";
import { SupplierRatingReconcile, SupplierRatingRecompute } from "./rating-runner";
import { SupplierRatings } from "./supplier-ratings.service";

/** A-SUP-03 «Рейтинг и отзывы» (context `admin`). */
@Controller()
export class AdminRatingsController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SupplierRatings) private readonly ratings: SupplierRatings) {}

  @SessionRoute(apiRoutes.getAdminSupplierRating)
  async rating(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
  ): Promise<AdminSupplierRatingResponse> {
    return { rating: await this.ratings.adminView(params.supplierId) };
  }
}

/** Tells the suppliers' list (A-SUP-02) its column and filter of the rating. */
@Injectable()
export class SupplierListRatingSource implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SupplierListCounts) private readonly listCounts: SupplierListCounts,
    @Inject(SupplierRatings) private readonly ratings: SupplierRatings,
  ) {}

  onModuleInit(): void {
    this.listCounts.registerRatings({
      of: (executor, supplierIds) => this.ratings.listOf(executor, supplierIds),
      condition: (filter) => this.ratings.listCondition(filter),
    });
  }
}

export interface RatingsModuleOptions {
  /** Serve the admin route (the API process only). */
  http: boolean;
  /** The signals module of the application, the very same instance. */
  signals: DynamicModule;
  /** The suppliers module of the application, the very same instance (its list's registry). */
  suppliers: DynamicModule;
}

/**
 * The rating of suppliers (TASK-050; PRODUCT 13; ARCHITECTURE 5.9, 13.2,
 * 4.71): the API's part — the administrator's view and the column of the
 * suppliers' list. The rating is written only by the worker
 * (`RatingJobsModule`), after an event and at night.
 */
@Module({})
export class RatingsModule {
  static forRoot(options: RatingsModuleOptions): DynamicModule {
    return {
      module: RatingsModule,
      imports: [options.signals, options.suppliers],
      controllers: options.http ? [AdminRatingsController] : [],
      providers: [SupplierRatings, SupplierListRatingSource],
      exports: [SupplierRatings],
    };
  }
}

/** The worker's part: the recalculation after an event and the nightly reconciliation. */
@Module({
  providers: [
    AdminSignals,
    AccountDirectory,
    SupplierRatings,
    SupplierRatingRecompute,
    SupplierRatingReconcile,
  ],
})
export class RatingJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(SupplierRatingRecompute) private readonly recompute: SupplierRatingRecompute,
    @Inject(SupplierRatingReconcile) private readonly reconcile: SupplierRatingReconcile,
  ) {}

  onModuleInit(): void {
    this.registry.handle(recomputeSupplierRatingJob, this.recompute);
    this.registry.handlePeriodic(reconcileRatingsJob, this.reconcile);
  }
}
