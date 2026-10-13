import { Inject, Module, type DynamicModule, type OnModuleInit } from "@nestjs/common";
import { JobRegistry } from "../../jobs";
import { CatalogRequestsService } from "./catalog-requests.service";
import { PriceImportApplier } from "./price-apply-runner";
import { PriceFileStorage } from "./price-file-storage";
import {
  applyPriceImportJob,
  deletePriceFilesJob,
  expirePriceImportsJob,
  expirePriceReviewsJob,
  matchPricesAiJob,
  matchPricesJob,
  parsePriceFileJob,
  readPriceValuesJob,
  wakePriceMatchingJob,
} from "./price-import-jobs";
import {
  PriceFileDeletion,
  PriceFileParser,
  PriceImportExpiry,
  PriceValuesReader,
} from "./price-import-runner";
import { PriceImportsAdminController, PriceImportsController } from "./price-imports.controller";
import { PriceImportsService } from "./price-imports.service";
import {
  PriceMatchAiJob,
  PriceMatcher,
  PriceMatchJob,
  PriceMatchWake,
  PriceReviewExpiry,
} from "./price-match-runner";
import { ModerationService } from "./moderation.service";
import { PriceExportController } from "./price-export.controller";
import { PriceExportService } from "./price-export.service";
import { CatalogRequestsAdminController, PriceReviewController } from "./price-review.controller";
import { PriceReviewService } from "./price-review.service";

export interface PriceImportsModuleOptions {
  /**
   * The catalog module of the application, the very same instance: items
   * are created through it from requests (A-MOD-01) and its photos give the
   * thumbnails of the review.
   */
  catalog: DynamicModule;
}

/**
 * Price list imports (ARCHITECTURE 5.6, 12.1, 4.66, 4.67; TASK-046,
 * TASK-047): the upload, the review and its application in the cabinet,
 * the requests to add an item in the admin panel — the API process.
 */
@Module({})
export class PriceImportsModule {
  static forRoot(options: PriceImportsModuleOptions): DynamicModule {
    return {
      module: PriceImportsModule,
      imports: [options.catalog],
      controllers: [
        PriceImportsController,
        PriceImportsAdminController,
        PriceReviewController,
        CatalogRequestsAdminController,
        PriceExportController,
      ],
      providers: [
        PriceImportsService,
        PriceFileStorage,
        PriceReviewService,
        CatalogRequestsService,
        ModerationService,
        PriceExportService,
      ],
      exports: [CatalogRequestsService],
    };
  }
}

/** Reading price files and their rows, matching and applying them, for the worker process. */
@Module({
  providers: [
    PriceFileStorage,
    PriceValuesReader,
    PriceFileParser,
    PriceImportExpiry,
    PriceFileDeletion,
    PriceMatcher,
    PriceMatchJob,
    PriceMatchAiJob,
    PriceMatchWake,
    PriceReviewExpiry,
    PriceImportApplier,
  ],
})
export class PriceImportJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(PriceFileParser) private readonly parser: PriceFileParser,
    @Inject(PriceValuesReader) private readonly values: PriceValuesReader,
    @Inject(PriceImportExpiry) private readonly expiry: PriceImportExpiry,
    @Inject(PriceFileDeletion) private readonly files: PriceFileDeletion,
    @Inject(PriceMatchJob) private readonly match: PriceMatchJob,
    @Inject(PriceMatchAiJob) private readonly matchAi: PriceMatchAiJob,
    @Inject(PriceMatchWake) private readonly wake: PriceMatchWake,
    @Inject(PriceReviewExpiry) private readonly reviews: PriceReviewExpiry,
    @Inject(PriceImportApplier) private readonly applier: PriceImportApplier,
  ) {}

  onModuleInit(): void {
    this.registry.handle(parsePriceFileJob, this.parser);
    this.registry.handle(readPriceValuesJob, this.values);
    this.registry.handlePeriodic(expirePriceImportsJob, this.expiry);
    this.registry.sweep(deletePriceFilesJob, this.files);
    this.registry.handle(matchPricesJob, this.match);
    this.registry.handle(matchPricesAiJob, this.matchAi);
    this.registry.handlePeriodic(wakePriceMatchingJob, this.wake);
    this.registry.handlePeriodic(expirePriceReviewsJob, this.reviews);
    this.registry.handle(applyPriceImportJob, this.applier);
  }
}
