import { Module, type DynamicModule } from "@nestjs/common";
import { Discipline } from "./order-discipline";
import { OrderLookup } from "./order-lookup.service";
import { OrderTransitions } from "./order-transitions";
import {
  AdminDisciplineController,
  AdminOrdersController,
  SupplierOrdersController,
  SupplierScanController,
  UserOrdersController,
} from "./orders.controller";
import { OrdersService } from "./orders.service";

export interface OrdersModuleOptions {
  /** Serve the routes (the API process only). */
  http: boolean;
  /**
   * The offers module of the application, the very same instance (the
   * snapshot of an offer, `OfferSnapshots`); imported, not created again.
   */
  offers: DynamicModule;
  /** The club access module of the application, the very same instance. */
  clubAccess: DynamicModule;
  /** The signals module of the application, the very same instance. */
  signals: DynamicModule;
}

/**
 * Orders on items in stock (ARCHITECTURE 5.7, 6.1, 6.5, 4.31, 4.32;
 * TASK-021, TASK-022): the state machine (`OrderTransitions`), creation,
 * giving an order out against the code or the QR (`OrderLookup`), the
 * discipline marks of users (`Discipline`), the views of each side and the
 * routes. The deadlines are applied by the worker (`OrderJobsModule`).
 */
@Module({})
export class OrdersModule {
  static forRoot(options: OrdersModuleOptions): DynamicModule {
    return {
      module: OrdersModule,
      imports: [options.offers, options.clubAccess, options.signals],
      controllers: options.http
        ? [
            UserOrdersController,
            SupplierOrdersController,
            SupplierScanController,
            AdminOrdersController,
            AdminDisciplineController,
          ]
        : [],
      providers: [Discipline, OrderTransitions, OrderLookup, OrdersService],
      exports: [OrdersService],
    };
  }
}
