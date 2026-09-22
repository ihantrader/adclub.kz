import { Module, type DynamicModule } from "@nestjs/common";
import { ShowcaseController } from "./showcase.controller";
import { ShowcaseService } from "./showcase.service";

export interface ShowcaseModuleOptions {
  /** Serve the client routes (the API process only). */
  http: boolean;
  /**
   * The very instances of the application's modules it reads through —
   * the catalog (photos), compatibility (the one calculation) and club
   * access (the one function) — imported, not created again.
   */
  catalog: DynamicModule;
  compatibility: DynamicModule;
  clubAccess: DynamicModule;
}

/**
 * The catalog for users (ARCHITECTURE 4.29; TASK-020): the items of a
 * subcategory and the card of an item with the offers users see, and what
 * each viewer may see of their suppliers.
 */
@Module({})
export class ShowcaseModule {
  static forRoot(options: ShowcaseModuleOptions): DynamicModule {
    return {
      module: ShowcaseModule,
      imports: [options.catalog, options.compatibility, options.clubAccess],
      controllers: options.http ? [ShowcaseController] : [],
      providers: [ShowcaseService],
      exports: [ShowcaseService],
    };
  }
}
