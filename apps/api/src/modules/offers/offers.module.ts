import { Module, type DynamicModule } from "@nestjs/common";
import { OfferItemSearch } from "./offer-item-search.service";
import { OfferSnapshots } from "./offer-snapshots";
import { OffersAdminController, OffersCabinetController } from "./offers.controller";
import { OffersService } from "./offers.service";

export interface OffersModuleOptions {
  /** Serve the cabinet and admin routes (the API process only). */
  http: boolean;
  /**
   * The catalog module of the application, the very same instance (its
   * photos give the thumbnails of items); imported, not created again.
   */
  catalog: DynamicModule;
}

/**
 * Offers of suppliers (ARCHITECTURE 5.5, 4.28; TASK-018): offers on
 * catalog goods and their changes, the search of an item for an offer,
 * the one rule of the showcase (`offerShowcase`/`shownOffers`), the
 * receipt date by the point's schedule and the snapshot orders keep.
 */
@Module({})
export class OffersModule {
  static forRoot(options: OffersModuleOptions): DynamicModule {
    return {
      module: OffersModule,
      imports: [options.catalog],
      controllers: options.http ? [OffersCabinetController, OffersAdminController] : [],
      providers: [OffersService, OfferItemSearch, OfferSnapshots],
      exports: [OffersService, OfferSnapshots],
    };
  }
}
