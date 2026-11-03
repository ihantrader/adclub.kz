import { Body, Controller, Inject, Param, Query } from "@nestjs/common";
import {
  addAdminPlanBodySchema,
  adminBillingPeriodQuerySchema,
  adminBillingSupplierListQuerySchema,
  adminChargeListQuerySchema,
  adminPlanPathSchema,
  adminUserSubscriptionListQuerySchema,
  apiRoutes,
  cancelAdminPlanBodySchema,
  type AddAdminPlanBody,
  type AdminBillingPeriodQuery,
  type AdminBillingPlans,
  type AdminBillingSummary,
  type AdminBillingSupplierPage,
  type AdminChargePage,
  type AdminPlanPath,
  type AdminUserSubscriptionListQuery,
  type AdminUserSubscriptionPage,
  type CancelAdminPlanBody,
} from "@adclub/contracts";
import { ZodValidationPipe } from "../../common/validation";
import { CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import {
  AdminBilling,
  type AdminBillingSupplierQuery,
  type AdminChargeQuery,
} from "./admin-billing.service";
import { Plans } from "./plans.service";

/** The administrator a session of the `admin` context belongs to (the access rule set it). */
function adminOf(session: AuthenticatedSession): {
  role: "admin";
  accountId: string;
  adminId: string;
} {
  if (!session.adminUserId) {
    throw new Error("An admin route reached without an administrator");
  }
  return { role: "admin", accountId: session.accountId, adminId: session.adminUserId };
}

/**
 * «Биллинг» of the admin panel (SCREENS 7.8 A-BILL-01…04; TASK-043): the
 * summary, the users' subscriptions, the suppliers' payments and the
 * tariffs. Only the tariff is changed here — through `Plans`, the very
 * service of the operator command.
 */
@Controller()
export class AdminBillingController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AdminBilling) private readonly billing: AdminBilling,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @SessionRoute(apiRoutes.getAdminBillingSummary)
  summary(
    @Query(new ZodValidationPipe(adminBillingPeriodQuerySchema)) query: AdminBillingPeriodQuery,
  ): Promise<AdminBillingSummary> {
    return this.billing.summary(query);
  }

  @SessionRoute(apiRoutes.listAdminUserSubscriptions)
  userSubscriptions(
    @Query(new ZodValidationPipe(adminUserSubscriptionListQuerySchema))
    query: AdminUserSubscriptionListQuery,
  ): Promise<AdminUserSubscriptionPage> {
    return this.billing.userSubscriptions(query);
  }

  @SessionRoute(apiRoutes.listAdminBillingSuppliers)
  suppliers(
    @Query(new ZodValidationPipe(adminBillingSupplierListQuerySchema))
    query: AdminBillingSupplierQuery,
  ): Promise<AdminBillingSupplierPage> {
    return this.billing.suppliers(query);
  }

  @SessionRoute(apiRoutes.listAdminCharges)
  charges(
    @Query(new ZodValidationPipe(adminChargeListQuerySchema)) query: AdminChargeQuery,
  ): Promise<AdminChargePage> {
    return this.billing.charges(query);
  }

  @SessionRoute(apiRoutes.getAdminBillingPlans)
  plansOf(): Promise<AdminBillingPlans> {
    return this.plans.forAdmin();
  }

  @SessionRoute(apiRoutes.addAdminBillingPlan)
  add(
    @Body(new ZodValidationPipe(addAdminPlanBodySchema)) body: AddAdminPlanBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminBillingPlans> {
    return this.plans.addByAdmin(body, adminOf(session));
  }

  @SessionRoute(apiRoutes.cancelAdminBillingPlan)
  cancel(
    @Param(new ZodValidationPipe(adminPlanPathSchema)) params: AdminPlanPath,
    @Body(new ZodValidationPipe(cancelAdminPlanBodySchema)) body: CancelAdminPlanBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<AdminBillingPlans> {
    return this.plans.cancelByAdmin(params.planId, body, adminOf(session));
  }
}
