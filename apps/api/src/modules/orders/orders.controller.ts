import { Body, Controller, Headers, Inject, Param, Query, Res } from "@nestjs/common";
import {
  adminCloseOrderBodySchema,
  adminDisciplineListQuerySchema,
  adminDisciplineUsersQuerySchema,
  adminOrderListQuerySchema,
  apiRoutes,
  createOrderBodySchema,
  declineOrderBodySchema,
  disciplinePathSchema,
  orderActionBodySchema,
  orderCredentialSchema,
  orderPathSchema,
  revokeDisciplineBodySchema,
  supplierOrderListQuerySchema,
  userOrderHistoryQuerySchema,
  userOrderListQuerySchema,
  type ActiveOrdersResponse,
  type AdminCloseOrderBody,
  type AdminDisciplineListQuery,
  type AdminDisciplineMarkResponse,
  type AdminDisciplinePage,
  type AdminDisciplineUsersPage,
  type AdminDisciplineUsersQuery,
  type AdminOrderListQuery,
  type AdminOrderPage,
  type AdminOrderResponse,
  type CloseOrderResponse,
  type CreateOrderInput,
  type CreateOrderResponse,
  type DeclineOrderBody,
  type DeclineOrderResponse,
  type DisciplinePath,
  type OrderActionBody,
  type OrderCredential,
  type OrderLookupResponse,
  type OrderPath,
  type RepeatOrderResponse,
  type RevokeDisciplineBody,
  type SupplierOrderListQuery,
  type SupplierOrderPage,
  type SupplierOrderResponse,
  type UserOrderHistoryPage,
  type UserOrderHistoryQuery,
  type UserOrderListQuery,
  type UserOrderPage,
  type UserOrderResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import type { Response } from "express";
import { ZodValidationPipe } from "../../common/validation";
import { RateLimitedRoute } from "../../rate-limit";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { Discipline } from "./order-discipline";
import { OrderLookup } from "./order-lookup.service";
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

  /**
   * The copy of every active order the app keeps on the device (PRODUCT
   * 6.7; SCREENS «Сохранённая копия»). It carries the confirmation codes
   * and the QRs, so it is never stored by anything on the way.
   */
  @RateLimitedRoute(apiRoutes.getActiveOrders)
  async active(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ActiveOrdersResponse> {
    response.setHeader("Cache-Control", "private, no-store");
    return this.orders.activeCopy(session.accountId, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.getOrderHistory)
  history(
    @Query(new ZodValidationPipe(userOrderHistoryQuerySchema)) query: UserOrderHistoryQuery,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<UserOrderHistoryPage> {
    return this.orders.historyPage(session.accountId, query, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.getOrderRepeat)
  repeat(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<RepeatOrderResponse> {
    return this.orders.repeat(session.accountId, params.orderId, pickLanguage(acceptLanguage));
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

  @RateLimitedRoute(apiRoutes.acceptSupplierOrder)
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

  @RateLimitedRoute(apiRoutes.markSupplierOrderReady)
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

  @RateLimitedRoute(apiRoutes.declineSupplierOrder)
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

/**
 * The scanner of the cabinet (context `supplier`; SCREENS S-SCAN-01…04):
 * the employee finds an order of their company by the code the customer
 * says or by the content of their QR, and gives it out. The credential is
 * sent in the body — never in a path or a query, where it would end up in
 * logs and caches.
 */
@Controller()
export class SupplierScanController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(OrderLookup) private readonly lookup: OrderLookup) {}

  @SessionRoute(apiRoutes.lookupSupplierOrder)
  find(
    @Body(new ZodValidationPipe(orderCredentialSchema)) body: OrderCredential,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<OrderLookupResponse> {
    return this.lookup.lookup(supplierActor(session), body, pickLanguage(acceptLanguage));
  }

  @SessionRoute(apiRoutes.closeSupplierOrder)
  close(
    @Body(new ZodValidationPipe(orderCredentialSchema)) body: OrderCredential,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CloseOrderResponse> {
    return this.lookup.close(supplierActor(session), body, pickLanguage(acceptLanguage));
  }
}

function adminActor(session: AuthenticatedSession): { accountId: string; adminId: string } {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { accountId: session.accountId, adminId: session.adminUserId };
}

/**
 * Any order for the administrator (context `admin`; A-ORD-01, A-ORD-02):
 * reading, and the one manual action of this task — closing a disputed
 * order without a code, with a reason (D-043).
 */
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

  @SessionRoute(apiRoutes.closeAdminOrder)
  async close(
    @Param(new ZodValidationPipe(orderPathSchema)) params: OrderPath,
    @Body(new ZodValidationPipe(adminCloseOrderBodySchema)) body: AdminCloseOrderBody,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminOrderResponse> {
    return {
      order: await this.orders.adminClose(
        adminActor(session),
        params.orderId,
        body,
        pickLanguage(acceptLanguage),
      ),
    };
  }
}

/**
 * The club's own discipline statistics of users (context `admin`; A-USR-02,
 * A-USR-03, A-ORD-02). Nothing of this is ever shown to a user, and no
 * route outside the admin context reads it.
 */
@Controller()
export class AdminDisciplineController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(Discipline) private readonly discipline: Discipline) {}

  @SessionRoute(apiRoutes.listAdminDiscipline)
  list(
    @Query(new ZodValidationPipe(adminDisciplineListQuerySchema)) query: AdminDisciplineListQuery,
  ): Promise<AdminDisciplinePage> {
    return this.discipline.page(query);
  }

  @SessionRoute(apiRoutes.listAdminDisciplineUsers)
  users(
    @Query(new ZodValidationPipe(adminDisciplineUsersQuerySchema)) query: AdminDisciplineUsersQuery,
  ): Promise<AdminDisciplineUsersPage> {
    return this.discipline.users(query);
  }

  @SessionRoute(apiRoutes.revokeAdminDiscipline)
  async revoke(
    @Param(new ZodValidationPipe(disciplinePathSchema)) params: DisciplinePath,
    @Body(new ZodValidationPipe(revokeDisciplineBodySchema)) body: RevokeDisciplineBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminDisciplineMarkResponse> {
    return {
      mark: await this.discipline.revokeByAdmin(params.markId, adminActor(session), body.reason),
    };
  }
}
