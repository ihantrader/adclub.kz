import { Module, type DynamicModule } from "@nestjs/common";
import { CatalogAdminController } from "./catalog-admin.controller";
import { CatalogAdminService } from "./catalog-admin.service";
import { CatalogReadService } from "./catalog-read.service";
import { CatalogController } from "./catalog.controller";
import { DevCatalogSeed } from "./dev-catalog-seed";

export interface CatalogModuleOptions {
  /** Serve the admin and client routes (the API process only). */
  http: boolean;
}

/**
 * The catalog structure (ARCHITECTURE 4.15, 5.2, 5.4; TASK-010):
 * categories, attributes and list options with their names, the admin
 * routes that keep them and the client routes that read the active part.
 * Items of the catalog arrive with TASK-011.
 */
@Module({})
export class CatalogModule {
  static forRoot(options: CatalogModuleOptions): DynamicModule {
    return {
      module: CatalogModule,
      controllers: options.http ? [CatalogController, CatalogAdminController] : [],
      providers: [CatalogAdminService, CatalogReadService, DevCatalogSeed],
      exports: [CatalogAdminService, CatalogReadService, DevCatalogSeed],
    };
  }
}
