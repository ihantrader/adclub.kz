import {
  Body,
  Controller,
  Headers,
  Inject,
  Injectable,
  Module,
  Param,
  Query,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
} from "@nestjs/common";
import {
  adminUserPathSchema,
  apiRoutes,
  cardBindingPathSchema,
  startCardBindingBodySchema,
  supplierAdminPathSchema,
  supplierChargesQuerySchema,
  type AdminSupplierBillingResponse,
  type AdminUserPath,
  type AdminUserSubscriptionResponse,
  type CardBindingPath,
  type CardBindingResponse,
  type MySubscriptionResponse,
  type PayNowResponse,
  type StartCardBindingBody,
  type StartCardBindingResponse,
  type SupplierAdminPath,
  type SupplierChargePage,
  type SupplierChargesQuery,
  type SupplierSubscriptionResponse,
} from "@adclub/contracts";
import { pickLanguage } from "@adclub/i18n";
import { type AppConfig } from "../../config";
import { ZodValidationPipe } from "../../common/validation";
import {
  JobRegistry,
  type JobHandler,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { RateLimitedRoute } from "../../rate-limit";
import {
  AccountDirectory,
  AccountStore,
  CurrentSession,
  SessionRoute,
  type AuthenticatedSession,
} from "../identity";
import { MessageSubjects } from "../messaging";
import { AdminSignals } from "../signals";
import { AdminBillingController } from "./admin-billing.controller";
import { AdminBilling } from "./admin-billing.service";
import { BillingOperator } from "./billing-operator";
import {
  applyPaymentWebhookJob,
  chargeDueJob,
  chargeSubscriptionJob,
  detachCardJob,
  expireCardBindingsJob,
  finishCardBindingJob,
  resolvePaymentsJob,
  runPaymentAttemptJob,
  watchPaymentProviderJob,
  applyBillingEventsJob,
  expireSubscriptionsJob,
  wakeBillingEventsJob,
} from "./billing-jobs";
import {
  ApplyPaymentWebhookHandler,
  ChargeDueHandler,
  ChargeSubscriptionHandler,
  DetachCardHandler,
  ExpireBindingsHandler,
  FinishBindingHandler,
  ResolvePaymentsHandler,
  RunAttemptHandler,
  WatchProviderHandler,
} from "./billing-handlers";
import { BillingNotices, PAYMENT_TERM_SUBJECT, SUBSCRIPTION_SUBJECT } from "./billing-notices";
import { CardBindings } from "./card-bindings";
import { DevPaymentCardController } from "./dev-payment-card.controller";
import { PaymentCharger } from "./payment-charger";
import { PaymentMethods } from "./payment-methods";
import { PaymentMetrics } from "./payment-metrics";
import { PaymentProvider } from "./payment-provider";
import { PaymentTokenVault } from "./payment-token-vault";
import { PaymentWebhookController, PaymentWebhooks } from "./payment-webhooks";
import { Plans } from "./plans.service";
import { SupplierBillingEffects } from "./supplier-billing-effects";
import { SupplierCards } from "./supplier-cards";
import { SubscriptionEvents, SubscriptionExpiry } from "./subscription-events";
import { chargeView, SubscriptionViews } from "./subscription-views";
import { TestPaymentProvider } from "./test-payment-provider";
import { UnconfiguredPaymentProvider } from "./unconfigured-payment-provider";
import { DatabaseService } from "../../database";
import { eq, sql } from "drizzle-orm";
import { subscription } from "./schema";

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

function companyOf(session: AuthenticatedSession): { supplierId: string; memberId: string } {
  if (!session.supplierId || !session.supplierMemberId) {
    throw new Error("A cabinet route reached without a company");
  }
  return { supplierId: session.supplierId, memberId: session.supplierMemberId };
}

/**
 * The cabinet's side of the money (S-BILL-01, TASK-042): the subscription and
 * its card, going to the provider's page and coming back, «Оплатить сейчас»,
 * the history of charges. Every employee of the company may; a blocked
 * company may too — the block is not lifted by paying, and paying is not
 * refused by it.
 */
@Controller()
export class SupplierBillingController {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SubscriptionViews) private readonly views: SubscriptionViews,
    @Inject(CardBindings) private readonly bindings: CardBindings,
    @Inject(PaymentCharger) private readonly charger: PaymentCharger,
  ) {}

  @SessionRoute(apiRoutes.getSupplierSubscription)
  company(
    @Headers("accept-language") acceptLanguage: string | undefined,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierSubscriptionResponse> {
    return this.views.ofSupplier(companyOf(session).supplierId, pickLanguage(acceptLanguage));
  }

  @RateLimitedRoute(apiRoutes.startSupplierCardBinding)
  async start(
    @Body(new ZodValidationPipe(startCardBindingBodySchema)) body: StartCardBindingBody,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<StartCardBindingResponse> {
    const { supplierId, memberId } = companyOf(session);
    const { binding, redirectUrl } = await this.bindings.start(
      supplierId,
      memberId,
      body.returnUrl,
    );
    return { binding: await this.bindings.view(binding), redirectUrl };
  }

  @SessionRoute(apiRoutes.getSupplierCardBinding)
  async binding(
    @Param(new ZodValidationPipe(cardBindingPathSchema)) params: CardBindingPath,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<CardBindingResponse> {
    const row = await this.bindings.get(companyOf(session).supplierId, params.bindingId);
    return { binding: await this.bindings.view(row) };
  }

  @RateLimitedRoute(apiRoutes.payNowSupplierSubscription)
  async pay(@CurrentSession() session: AuthenticatedSession): Promise<PayNowResponse> {
    const { supplierId, memberId } = companyOf(session);
    const attempt = await this.charger.payNow(supplierId, memberId);
    return { charge: chargeView(attempt) };
  }

  @SessionRoute(apiRoutes.listSupplierCharges)
  charges(
    @Query(new ZodValidationPipe(supplierChargesQuerySchema)) query: SupplierChargesQuery,
    @CurrentSession() session: AuthenticatedSession,
  ): Promise<SupplierChargePage> {
    return this.views.chargesOf(companyOf(session).supplierId, query);
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

  @SessionRoute(apiRoutes.getAdminSupplierBilling)
  ofSupplier(
    @Param(new ZodValidationPipe(supplierAdminPathSchema)) params: SupplierAdminPath,
  ): Promise<AdminSupplierBillingResponse> {
    return this.views.forAdminSupplier(params.supplierId);
  }
}

export interface BillingModuleOptions {
  /** Sample the charges for the metrics (the process that serves them). */
  metrics?: boolean;
  /** Serve the routes (the API process only). */
  http: boolean;
  /** The club access module of the application, the very same instance. */
  clubAccess: DynamicModule;
  /** The signals module of the application, the very same instance. */
  signals: DynamicModule;
}

/** What both processes need to talk to the card processor and keep its cards. */
function paymentProviders(config: AppConfig): Provider[] {
  const { provider, testMode, webhookSecret } = config.payments;
  if (provider === "card_kz") {
    return [{ provide: PaymentProvider, useClass: UnconfiguredPaymentProvider }];
  }
  return [
    {
      provide: TestPaymentProvider,
      useFactory: () => {
        const test = new TestPaymentProvider(
          webhookSecret ?? `no-webhook-${Math.random().toString(36)}`,
        );
        test.mode = testMode;
        return test;
      },
    },
    { provide: PaymentProvider, useExisting: TestPaymentProvider },
  ];
}

/** The pieces the API and the worker both use, in one list. */
const billingCore: Provider[] = [
  Plans,
  PaymentTokenVault,
  PaymentMethods,
  BillingNotices,
  SupplierBillingEffects,
  SubscriptionEvents,
  PaymentCharger,
  CardBindings,
  PaymentWebhooks,
];

/**
 * Subscriptions (EPIC-14, TASK-040, TASK-042; PRODUCT 14; ARCHITECTURE 5.10,
 * 9.4, 4.72, 4.77): tariffs, the events of providers, the views of a
 * subscription, and — for suppliers — the card, its trip to the processor's
 * page, the charges and the webhook. The status of a subscription changes only
 * in the worker (`BillingJobsModule`); club access reads it through
 * `ClubAccess`. The card processor sits behind `PaymentProvider`: the test
 * one until the contract with the acquirer exists (`PAYMENT_PROVIDER`).
 */
@Module({})
export class BillingModule {
  static forRoot(config: AppConfig, options: BillingModuleOptions): DynamicModule {
    const devCardPage =
      options.http && config.payments.provider === "test" && config.loginCode.devOutbox;
    return {
      module: BillingModule,
      imports: [options.clubAccess, options.signals],
      controllers: options.http
        ? [
            MySubscriptionController,
            SupplierBillingController,
            AdminSubscriptionController,
            AdminBillingController,
            PaymentWebhookController,
            ...(devCardPage ? [DevPaymentCardController] : []),
          ]
        : [],
      providers: [
        AccountStore,
        ...paymentProviders(config),
        ...billingCore,
        SubscriptionViews,
        AdminBilling,
        SupplierCards,
        BillingOperator,
        ...(options.metrics ? [PaymentMetrics] : []),
      ],
      exports: [
        Plans,
        SubscriptionEvents,
        SubscriptionViews,
        AdminBilling,
        SupplierCards,
        BillingOperator,
        PaymentMethods,
        PaymentProvider,
      ],
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

/** The worker's part: the events of providers and of time, the charges, the cards. */
@Module({})
export class BillingJobsModule implements OnModuleInit {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: BillingJobsModule,
      providers: [
        AdminSignals,
        AccountDirectory,
        ...paymentProviders(config),
        ...billingCore,
        SubscriptionExpiry,
        BillingEventsApply,
        BillingEventsWake,
        ChargeDueHandler,
        ChargeSubscriptionHandler,
        RunAttemptHandler,
        ResolvePaymentsHandler,
        FinishBindingHandler,
        ApplyPaymentWebhookHandler,
        DetachCardHandler,
        ExpireBindingsHandler,
        WatchProviderHandler,
      ],
    };
  }

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(BillingEventsApply) private readonly apply: BillingEventsApply,
    @Inject(BillingEventsWake) private readonly wake: BillingEventsWake,
    @Inject(SubscriptionExpiry) private readonly expiry: SubscriptionExpiry,
    @Inject(ChargeDueHandler) private readonly chargeDue: ChargeDueHandler,
    @Inject(ChargeSubscriptionHandler)
    private readonly chargeSubscription: ChargeSubscriptionHandler,
    @Inject(RunAttemptHandler) private readonly runAttempt: RunAttemptHandler,
    @Inject(ResolvePaymentsHandler) private readonly resolve: ResolvePaymentsHandler,
    @Inject(FinishBindingHandler) private readonly finishBinding: FinishBindingHandler,
    @Inject(ApplyPaymentWebhookHandler) private readonly applyWebhook: ApplyPaymentWebhookHandler,
    @Inject(DetachCardHandler) private readonly detach: DetachCardHandler,
    @Inject(ExpireBindingsHandler) private readonly expireBindings: ExpireBindingsHandler,
    @Inject(WatchProviderHandler) private readonly watch: WatchProviderHandler,
    @Inject(MessageSubjects) private readonly subjects: MessageSubjects,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.registry.handle(applyBillingEventsJob, this.apply);
    this.registry.handlePeriodic(wakeBillingEventsJob, this.wake);
    this.registry.sweep(expireSubscriptionsJob, this.expiry);
    this.registry.handlePeriodic(chargeDueJob, this.chargeDue);
    this.registry.handle(chargeSubscriptionJob, this.chargeSubscription);
    this.registry.handle(runPaymentAttemptJob, this.runAttempt);
    this.registry.handlePeriodic(resolvePaymentsJob, this.resolve);
    this.registry.handle(finishCardBindingJob, this.finishBinding);
    this.registry.handle(applyPaymentWebhookJob, this.applyWebhook);
    this.registry.handle(detachCardJob, this.detach);
    this.registry.handlePeriodic(expireCardBindingsJob, this.expireBindings);
    this.registry.handlePeriodic(watchPaymentProviderJob, this.watch);
    // W-05 goes only while the subscription is still past due: one paid in
    // the meantime must not be told it failed.
    this.subjects.register(SUBSCRIPTION_SUBJECT, {
      stillSend: async (tx, subjectId) => {
        if (!subjectId) return false;
        const [row] = await tx
          .select({ status: subscription.status })
          .from(subscription)
          .where(eq(subscription.id, subjectId));
        return row?.status === "past_due";
      },
      onResult: () => Promise.resolve(),
    });
    // W-05 goes while the term of the refused charge is not paid (I834): the
    // refusal's event may not be applied yet when the sender takes the
    // message, so the subscription's status is not what decides.
    this.subjects.register(PAYMENT_TERM_SUBJECT, {
      stillSend: async (tx, subjectId) => {
        if (!subjectId) return false;
        const { rows } = await tx.execute<{ unpaid: boolean }>(sql`
          SELECT NOT EXISTS (
            SELECT 1 FROM payment_attempt paid
            WHERE paid.period_key = a.period_key AND paid.status = 'succeeded'
          ) AND s.status IN ('active', 'past_due') AS unpaid
          FROM payment_attempt a JOIN subscription s ON s.id = a.subscription_id
          WHERE a.id = ${subjectId}
        `);
        return rows[0]?.unpaid === true;
      },
      onResult: () => Promise.resolve(),
    });
  }
}
