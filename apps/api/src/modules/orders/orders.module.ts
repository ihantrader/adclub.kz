import { Module, type DynamicModule } from "@nestjs/common";
import { OrderTransitions } from "./order-transitions";
import {
  AdminOrdersController,
  SupplierOrdersController,
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
}

/**
 * Orders on items in stock (ARCHITECTURE 5.7, 6.1, 4.31; TASK-021): the
 * state machine (`OrderTransitions`), creation, the views of each side and
 * the routes. The deadlines are applied by the worker (`OrderJobsModule`).
 */
@Module({})
export class OrdersModule {
  static forRoot(options: OrdersModuleOptions): DynamicModule {
    return {
      module: OrdersModule,
      imports: [options.offers, options.clubAccess],
      controllers: options.http
        ? [UserOrdersController, SupplierOrdersController, AdminOrdersController]
        : [],
      providers: [OrderTransitions, OrdersService],
      exports: [OrdersService],
    };
  }
}
