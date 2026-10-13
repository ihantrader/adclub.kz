import { Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import { ComplaintsService } from "./complaints.service";
import { ReviewCheckExpiry, ReviewChecker } from "./review-check";
import { ReviewFeedback } from "./review-feedback";
import { checkReviewJob, expireReviewChecksJob } from "./review-jobs";
import {
  AdminReviewsController,
  SupplierReviewsController,
  UserReviewsController,
} from "./reviews.controller";
import { ReviewsService } from "./reviews.service";

export interface ReviewsModuleOptions {
  /** Serve the routes (the API process only). */
  http: boolean;
  /**
   * The orders module of the application, the very same instance: the
   * views of an order get this module's part through its registry.
   */
  orders: DynamicModule;
  /** The club access module of the application: who sees the supplier's page. */
  clubAccess: DynamicModule;
}

/**
 * Reviews and complaints of users about orders (TASK-049; PRODUCT 13; D-042;
 * ARCHITECTURE 5.9, 4.69): creation and the author's actions, the
 * administrator's decisions, the supplier's public page, and the part of the
 * views of an order. The check of a text runs in the worker
 * (`ReviewJobsModule`).
 */
@Module({})
export class ReviewsModule {
  static forRoot(options: ReviewsModuleOptions): DynamicModule {
    return {
      module: ReviewsModule,
      imports: [options.orders, options.clubAccess],
      controllers: options.http
        ? [UserReviewsController, SupplierReviewsController, AdminReviewsController]
        : [],
      providers: [ReviewsService, ComplaintsService, ReviewFeedback],
      exports: [ReviewsService, ComplaintsService],
    };
  }
}

/** The worker's part: the check of a review's text and the end of a wait too long. */
@Module({ providers: [ReviewChecker, ReviewCheckExpiry] })
export class ReviewJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(ReviewChecker) private readonly checker: ReviewChecker,
    @Inject(ReviewCheckExpiry) private readonly expiry: ReviewCheckExpiry,
  ) {}

  onModuleInit(): void {
    this.registry.handle(checkReviewJob, this.checker);
    this.registry.sweep(expireReviewChecksJob, this.expiry);
  }
}
