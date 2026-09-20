import { Module, type DynamicModule } from "@nestjs/common";
import { CatalogAdminController } from "./catalog-admin.controller";
import { CatalogAdminService } from "./catalog-admin.service";
import { CatalogBrandsService } from "./catalog-brands.service";
import { CatalogItemsController } from "./catalog-items.controller";
import { CatalogItemsService } from "./catalog-items.service";
import { CatalogReadService } from "./catalog-read.service";
import { CatalogController } from "./catalog.controller";
import { DevCatalogSeed } from "./dev-catalog-seed";
import { TranslationAdminController } from "./translation-admin.controller";
import { TranslationAdminService } from "./translation-admin.service";
import { TranslationMetrics } from "./translation-runner";
import { TranslationQueue } from "./translation-queue.service";

export interface CatalogModuleOptions {
  /** Serve the admin and client routes (the API process only). */
  http: boolean;
  /** Sample the translation queue for metrics (the process that serves them). */
  metrics?: boolean;
}

/**
 * The catalog structure (ARCHITECTURE 4.15, 5.2, 5.4; TASK-010):
 * categories, attributes and list options with their names, the admin
 * routes that keep them and the client routes that read the active part;
 * brands, items, their values and analogs (TASK-011, ARCHITECTURE 4.17).
 */
@Module({})
export class CatalogModule {
  static forRoot(options: CatalogModuleOptions): DynamicModule {
    return {
      module: CatalogModule,
      controllers: options.http
        ? [
            CatalogController,
            CatalogAdminController,
            CatalogItemsController,
            TranslationAdminController,
          ]
        : [],
      providers: [
        CatalogAdminService,
        CatalogBrandsService,
        CatalogItemsService,
        CatalogReadService,
        DevCatalogSeed,
        TranslationQueue,
        TranslationAdminService,
        ...(options.metrics ? [TranslationMetrics] : []),
      ],
      exports: [
        CatalogAdminService,
        CatalogBrandsService,
        CatalogItemsService,
        CatalogReadService,
        DevCatalogSeed,
        TranslationQueue,
        TranslationAdminService,
      ],
    };
  }
}
