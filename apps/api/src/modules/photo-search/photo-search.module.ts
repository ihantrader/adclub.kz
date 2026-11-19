import {
  Controller,
  Headers,
  Inject,
  Injectable,
  Module,
  Param,
  Query,
  Req,
  Res,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  apiRoutes,
  catalogItemIdPathSchema,
  catalogRequestIdPathSchema,
  offerPathSchema,
  supplierModerationPhotoQuerySchema,
  type CatalogItemIdPath,
  type OfferPath,
  type SearchItemPhotosResponse,
  type SupplierModerationPhotoPage,
  type SupplierModerationPhotoQuery,
  type SupplierOfferPhotos,
  type SupplierPhotoUploadResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { sql } from "drizzle-orm";
import { ZodValidationPipe } from "../../common/validation";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { JobRegistry } from "../../jobs";
import { Metrics } from "../../observability";
import { RateLimitedRoute } from "../../rate-limit";
import { adminActor, CatalogPhotosService } from "../catalog";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import {
  IMAGE_SEARCH_PROVIDER,
  PHOTO_FETCHER,
  type ImageSearchProvider,
} from "./image-search-provider";
import { HttpPhotoFetcher, type PhotoFetcher } from "./photo-fetcher";
import { PhotoSearchRunner, photoSearchJob } from "./photo-search-job";
import { PhotoSearchService } from "./photo-search.service";
import { SerpApiImageSearch } from "./serpapi-image-search";
import { SupplierPhotosService, type SupplierPhotoActor } from "./supplier-photos.service";
import { FixturePhotoFetcher, loadPhotoSearchFixtures, TestImageSearch } from "./test-image-search";

function supplierActor(session: AuthenticatedSession): SupplierPhotoActor {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A cabinet route reached without a company");
  }
  return {
    supplierId: session.supplierId,
    memberId: session.supplierMemberId,
    accountId: session.accountId,
  };
}

function bodyOf(request: Request): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}

/** «Найти фото» of the admin panel (context `admin`). */
@Controller()
export class AdminPhotoSearchController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PhotoSearchService) private readonly search: PhotoSearchService) {}

  @SessionRoute(apiRoutes.searchItemPhotos)
  find(
    @Param(new ZodValidationPipe(catalogItemIdPathSchema)) params: CatalogItemIdPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SearchItemPhotosResponse> {
    const actor = adminActor(session);
    if (actor.role !== "admin") throw new Error("An admin route reached without an admin");
    return this.search.searchByAdmin(params.itemId, actor);
  }
}

/**
 * Photos of suppliers in the cabinet (context `supplier`; S-OFF-03, S-OFF-05,
 * S-MOD-01). The uploads take the file as the body, read as bytes by
 * `UploadBodyMiddleware` after the limit by person was counted.
 */
@Controller()
export class SupplierPhotosController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SupplierPhotosService) private readonly supplierPhotos: SupplierPhotosService,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  @SessionRoute(apiRoutes.getSupplierOfferPhotos)
  ofOffer(
    @Param(new ZodValidationPipe(offerPathSchema)) params: OfferPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOfferPhotos> {
    return this.supplierPhotos.ofOffer(supplierActor(session), params.offerId);
  }

  @RateLimitedRoute(apiRoutes.uploadSupplierOfferPhoto)
  async uploadToOffer(
    @Param(new ZodValidationPipe(offerPathSchema)) params: OfferPath,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierPhotoUploadResponse> {
    const result = await this.photos.uploadFromSupplier(
      { offerId: params.offerId },
      bodyOf(request),
      supplierActor(session),
    );
    response.status(result.created ? 201 : 200);
    return result;
  }

  @RateLimitedRoute(apiRoutes.uploadCatalogRequestPhoto)
  async uploadToRequest(
    @Param(new ZodValidationPipe(catalogRequestIdPathSchema)) params: { requestId: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierPhotoUploadResponse> {
    const result = await this.photos.uploadFromSupplier(
      { requestId: params.requestId },
      bodyOf(request),
      supplierActor(session),
    );
    response.status(result.created ? 201 : 200);
    return result;
  }

  @SessionRoute(apiRoutes.listSupplierModerationPhotos)
  moderation(
    @Query(new ZodValidationPipe(supplierModerationPhotoQuerySchema))
    query: SupplierModerationPhotoQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierModerationPhotoPage> {
    return this.supplierPhotos.page(supplierActor(session), query, pickLanguage(acceptLanguage));
  }
}

/** The image search and the downloader by configuration (TASK-068). */
function searchProviders() {
  return [
    {
      provide: IMAGE_SEARCH_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ImageSearchProvider | null => {
        switch (config.imageSearch.provider) {
          case "serpapi":
            return new SerpApiImageSearch({ apiKey: config.imageSearch.serpApiKey! });
          case "test":
            return new TestImageSearch(loadPhotoSearchFixtures(), config.imageSearch.testMode);
          case "disabled":
            return null;
        }
      },
    },
    {
      provide: PHOTO_FETCHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PhotoFetcher =>
        config.imageSearch.provider === "test"
          ? new FixturePhotoFetcher(loadPhotoSearchFixtures())
          : new HttpPhotoFetcher(),
    },
  ];
}

/** The image search of the day and the photos waiting, for `GET /metrics` (from the database). */
@Injectable()
export class PhotoSearchMetrics implements OnModuleInit {
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectPhotoSearch(async () => {
      const db = this.database.db;
      const dayStart = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;
      const [searches, waiting] = await Promise.all([
        db.execute<{ trigger: string; status: string; n: number; candidates: number }>(sql`
          SELECT trigger, status, count(*)::int AS n, coalesce(sum(candidates), 0)::int AS candidates
          FROM photo_search WHERE created_at >= ${dayStart} GROUP BY trigger, status`),
        db.execute<{ proposed_by: string; n: number }>(sql`
          SELECT proposed_by, count(*)::int AS n FROM item_photo
          WHERE status = 'proposed' AND proposed_by IN ('ai', 'supplier') AND item_id IS NOT NULL
          GROUP BY proposed_by`),
      ]);
      this.metrics.setPhotoSearchState({
        searches: searches.rows.map((row) => ({
          trigger: row.trigger,
          status: row.status,
          count: Number(row.n),
        })),
        candidates: searches.rows.reduce((sum, row) => sum + Number(row.candidates), 0),
        waiting: waiting.rows.map((row) => ({ proposedBy: row.proposed_by, count: Number(row.n) })),
      });
    });
  }
}

export interface PhotoSearchModuleOptions {
  /** The catalog module of the application, the very same instance. */
  catalog: DynamicModule;
  http?: boolean;
}

/**
 * The image search of photos of items and photos of suppliers (TASK-068;
 * ARCHITECTURE 4.95) — the API process.
 */
@Module({})
export class PhotoSearchModule {
  static forRoot(options: PhotoSearchModuleOptions): DynamicModule {
    return {
      module: PhotoSearchModule,
      imports: [options.catalog],
      controllers:
        options.http === false ? [] : [AdminPhotoSearchController, SupplierPhotosController],
      providers: [
        ...searchProviders(),
        PhotoSearchService,
        SupplierPhotosService,
        ...(options.http === false ? [] : [PhotoSearchMetrics]),
      ],
      exports: [PhotoSearchService],
    };
  }
}

/** The worker's part: `catalog.search-photos`. */
@Module({})
export class PhotoSearchJobsModule implements OnModuleInit {
  static forRoot(options: { catalog: DynamicModule }): DynamicModule {
    return {
      module: PhotoSearchJobsModule,
      imports: [options.catalog],
      providers: [...searchProviders(), PhotoSearchService, PhotoSearchRunner],
    };
  }

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(PhotoSearchRunner) private readonly runner: PhotoSearchRunner,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(photoSearchJob, this.runner);
  }
}
