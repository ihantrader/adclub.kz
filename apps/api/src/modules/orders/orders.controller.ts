import { Body, Controller, Headers, Inject, Param, Query } from "@nestjs/common";
import {
  adminOrderListQuerySchema,
  apiRoutes,
  createOrderBodySchema,
  declineOrderBodySchema,
  orderActionBodySchema,
  orderPathSchema,
  supplierOrderListQuerySchema,
  userOrderListQuerySchema,
  type AdminOrderListQuery,
  type AdminOrderPage,
  type AdminOrderResponse,
  type CreateOrderInput,
  type CreateOrderResponse,
  type DeclineOrderBody,
  type DeclineOrderResponse,
  type OrderActionBody,
  type OrderPath,
  type SupplierOrderListQuery,
  type SupplierOrderPage,
  type SupplierOrderResponse,
  type UserOrderListQuery,
  type UserOrderPage,
  type UserOrderResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { OrdersService, type OrderSupplierActor } from "./orders.service";

function supplierActor(session: AuthenticatedSession): OrderSupplierActor {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A cabinet route reached without a company");
  }
  return {
    type: "supplier_member",
    accountId: session.accountId,
    supplierId: session.supplierId,
    memberId: session.supplierMemberId,
  };
}

/**
 * The user's own orders (context `user`, the mobile app; SCREENS
 * M-ORD-01…03). Another user's order answers like a missing one (404).
 */
@Controller()
export class UserOrdersController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @SessionRoute(apiRoutes.createOrder)
  create(
    @Body(new ZodValidationPipe(createOrderBodySchema)) body: CreateOrderInput,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CreateOrderResponse> {
    return this.orders.create(body, session.accountId, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.listUserOrders)
  list(
    @Query(new ZodValidationPipe(userOrderListQuerySchema)) query: UserOrderListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserOrderPage> {
    return this.orders.userPage(session.accountId, query, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.getUserOrder)
  async one(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserOrderResponse> {
    return {
      order: await this.orders.userOrder(
        session.accountId,
        params.orderId,
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.cancelUserOrder)
  async cancel(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserOrderResponse> {
    return {
      order: await this.orders.cancel(
        session.accountId,
        params.orderId,
        pickLanguage(acceptLanguage),
      ),
    };
  }
}

/**
 * Orders of the company in the cabinet (context `supplier`; SCREENS
 * S-ORD-01…03). The company is always the session's; another company's
 * order answers like a missing one (404). Every action is recorded against
 * the employee of the session.
 */
@Controller()
export class SupplierOrdersController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @SessionRoute(apiRoutes.listSupplierOrders)
  list(
    @Query(new ZodValidationPipe(supplierOrderListQuerySchema)) query: SupplierOrderListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOrderPage> {
    return this.orders.supplierPage(
      supplierActor(session).supplierId,
      query,
      pickLanguage(acceptLanguage),
    );
  }

  @SessionRoute(apiRoutes.getSupplierOrder)
  async one(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOrderResponse> {
    return {
      order: await this.orders.supplierOrder(
        supplierActor(session).supplierId,
        params.orderId,
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.acceptSupplierOrder)
  async accept(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Body(new ZodValidationPipe(orderActionBodySchema)) body: OrderActionBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOrderResponse> {
    return {
      order: await this.orders.accept(
        supplierActor(session),
        params.orderId,
        body.expectedVersion,
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.markSupplierOrderReady)
  async ready(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Body(new ZodValidationPipe(orderActionBodySchema)) body: OrderActionBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierOrderResponse> {
    return {
      order: await this.orders.markReady(
        supplierActor(session),
        params.orderId,
        body.expectedVersion,
        pickLanguage(acceptLanguage),
      ),
    };
  }

  @SessionRoute(apiRoutes.declineSupplierOrder)
  decline(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Body(new ZodValidationPipe(declineOrderBodySchema)) body: DeclineOrderBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<DeclineOrderResponse> {
    return this.orders.decline(
      supplierActor(session),
      params.orderId,
      body,
      pickLanguage(acceptLanguage),
    );
  }
}

/** Any order for the administrator, read only (context `admin`; A-ORD-01, A-ORD-02). */
@Controller()
export class AdminOrdersController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @SessionRoute(apiRoutes.listAdminOrders)
  list(
    @Query(new ZodValidationPipe(adminOrderListQuerySchema)) query: AdminOrderListQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<AdminOrderPage> {
    return this.orders.adminPage(query, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.getAdminOrder)
  async one(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
  ): Promise<AdminOrderResponse> {
    return { order: await this.orders.adminOrder(params.orderId, pickLanguage(acceptLanguage)) };
  }
}
