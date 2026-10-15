import {
  Controller,
  Headers,
  Inject,
  Injectable,
  Module,
  Param,
  type DynamicModule,
  type OnModuleInit,
} from "@nestjs/common";
import {
  adminUserPathSchema,
  apiRoutes,
  type AdminUserPath,
  type AdminUserSubscriptionResponse,
  type MySubscriptionResponse,
  type SupplierSubscriptionResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { ZodValidationPipe } from "../../common/validation";
import {
  JobRegistry,
  type JobHandler,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { AccountStore, CurrentSession, SessionRoute, type AuthenticatedSession } from "../identity";
import { BillingOperator } from "./billing-operator";
import {
  applyBillingEventsJob,
  expireSubscriptionsJob,
  wakeBillingEventsJob,
} from "./billing-jobs";
import { Plans } from "./plans.service";
import { SupplierCards } from "./supplier-cards";
import { SubscriptionEvents, SubscriptionExpiry } from "./subscription-events";
import { SubscriptionViews } from "./subscription-views";

/** `GET /me/subscription` (context `user`, M-SUB-02). */
@Controller()
export class MySubscriptionController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SubscriptionViews) private readonly views: SubscriptionViews) {}

  @SessionRoute(apiRoutes.getMySubscription)
  mine(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<MySubscriptionResponse> {
    return this.views.mine(session.accountId, pickLanguage(acceptLanguage));
  }
}

/** `GET /supplier/subscription` (context `supplier`; S-BILL-01 — TASK-042). */
@Controller()
export class SupplierSubscriptionController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SubscriptionViews) private readonly views: SubscriptionViews) {}

  @SessionRoute(apiRoutes.getSupplierSubscription)
  company(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierSubscriptionResponse> {
    if (!session.supplierId) {
      throw new Error("A cabinet route reached without a company");
    }
    return this.views.ofSupplier(session.supplierId, pickLanguage(acceptLanguage));
  }
}

/** `GET /admin/users/{accountId}/subscription` (context `admin`, A-USR-02). */
@Controller()
export class AdminSubscriptionController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SubscriptionViews) private readonly views: SubscriptionViews) {}

  @SessionRoute(apiRoutes.getAdminUserSubscription)
  ofUser(
    @Param(new ZodValidationPipe(adminUserPathSchema)) params: AdminUserPath,
  ): Promise<AdminUserSubscriptionResponse> {
    return this.views.forAdmin(params.accountId);
  }
}

export interface BillingModuleOptions {
  /** Serve the routes (the API process only). */
  http: boolean;
  /** The club access module of the application, the very same instance. */
  clubAccess: DynamicModule;
}

/**
 * Subscriptions (EPIC-14, TASK-040; PRODUCT 14; ARCHITECTURE 5.10, 9.4,
 * 4.72): tariffs, the events of providers and the views of a subscription.
 * The status of a subscription changes only in the worker
 * (`BillingJobsModule`); club access reads it through `ClubAccess`.
 */
@Module({})
export class BillingModule {
  static forRoot(options: BillingModuleOptions): DynamicModule {
    return {
      module: BillingModule,
      imports: [options.clubAccess],
      controllers: options.http
        ? [MySubscriptionController, SupplierSubscriptionController, AdminSubscriptionController]
        : [],
      providers: [
        AccountStore,
        Plans,
        SubscriptionEvents,
        SubscriptionViews,
        SupplierCards,
        BillingOperator,
      ],
      exports: [Plans, SubscriptionEvents, SubscriptionViews, SupplierCards, BillingOperator],
    };
  }
}

/** `billing.apply-events`: the pending events of one purchase. */
@Injectable()
export class BillingEventsApply implements JobHandler<{ provider: string; providerRef: string }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SubscriptionEvents) private readonly events: SubscriptionEvents) {}

  async run(
    { provider, providerRef }: { provider: string; providerRef: string },
    _context: JobRunContext,
  ): Promise<void> {
    await this.events.applyPurchase(provider, providerRef);
  }
}

/** `billing.wake-events`: purchases whose events waited too long. */
@Injectable()
export class BillingEventsWake implements PeriodicJobHandler {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(SubscriptionEvents) private readonly events: SubscriptionEvents) {}

  async run(_context: JobRunContext): Promise<JobRunOutcome> {
    return { worked: (await this.events.wake()) > 0 };
  }
}

/** The worker's part: the events of providers and of time. */
@Module({
  providers: [Plans, SubscriptionEvents, SubscriptionExpiry, BillingEventsApply, BillingEventsWake],
})
export class BillingJobsModule implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(BillingEventsApply) private readonly apply: BillingEventsApply,
    @Inject(BillingEventsWake) private readonly wake: BillingEventsWake,
    @Inject(SubscriptionExpiry) private readonly expiry: SubscriptionExpiry,
  ) {}

  onModuleInit(): void {
    this.registry.handle(applyBillingEventsJob, this.apply);
    this.registry.handlePeriodic(wakeBillingEventsJob, this.wake);
    this.registry.sweep(expireSubscriptionsJob, this.expiry);
  }
}
