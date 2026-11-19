import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { normalizeKzMobilePhone, providerEventKinds, type ProviderEventKind } from "@adclub/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  APPLE_STORE_WEBHOOK_PATH,
  GOOGLE_STORE_WEBHOOK_PATH,
  PAYMENT_WEBHOOK_PATH,
} from "../../common/http";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { AccountStore, OperatorCommandError } from "../identity";
import { Plans } from "./plans.service";
import { openAttemptStatuses, paymentAttempt, storePurchase, subscription } from "./schema";
import { devAppleJws, devGoogleOidcToken, devPubsubPush } from "./stores/dev-store-signing";
import { SubscriptionEvents } from "./subscription-events";
import { TestSubscriptionProvider, type TestProviderEvent } from "./subscription-provider";
import { SubscriptionViews } from "./subscription-views";
import { PAYMENT_WEBHOOK_SIGNATURE_HEADER, signPaymentWebhook } from "./test-payment-provider";

export interface TestEventCommand {
  phone: string;
  kind: string;
  /** `started`, `renewed`: the end of the paid term. */
  periodEnd?: Date;
  /** `grace_started`: the end of the grace. */
  graceUntil?: Date;
  /** When it happened at the provider; now by default. */
  at?: Date;
  /** The event's id at the provider (the same id twice — one event); a new one by default. */
  eventId?: string;
  /** The purchase; by default the account's latest test purchase (a new one for `started` without any). */
  ref?: string;
}

/**
 * The operator's side of subscriptions (TASK-040): the test provider's
 * events (`dev:subscription:event`, development and tests only — the
 * command refuses elsewhere) go the very way a provider's do — the
 * provider's port reads them, `SubscriptionEvents.receive` keeps them and
 * the worker applies them; and a subscription's state by a phone number.
 */
@Injectable()
export class BillingOperator {
  private readonly provider = new TestSubscriptionProvider();

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(SubscriptionEvents) private readonly events: SubscriptionEvents,
    @Inject(SubscriptionViews) private readonly views: SubscriptionViews,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  private async accountOf(phoneInput: string): Promise<string> {
    const phone = normalizeKzMobilePhone(phoneInput);
    if (!phone) {
      throw new OperatorCommandError("Not a Kazakhstan mobile number (+7 7xx xxx xx xx)");
    }
    const owner = await this.accounts.findByPhone(phone);
    if (!owner) {
      throw new OperatorCommandError("No account with this number: sign in with it first");
    }
    return owner.id;
  }

  async testEvent(command: TestEventCommand) {
    if (!(providerEventKinds as readonly string[]).includes(command.kind)) {
      throw new OperatorCommandError(`<event> is one of: ${providerEventKinds.join(", ")}`);
    }
    const kind = command.kind as ProviderEventKind;
    const accountId = await this.accountOf(command.phone);
    let ref = command.ref;
    if (!ref) {
      const [latest] = await this.database.db
        .select({ ref: subscription.providerRef })
        .from(subscription)
        .where(and(eq(subscription.accountId, accountId), eq(subscription.provider, "test")))
        .orderBy(desc(subscription.createdAt))
        .limit(1);
      if (latest) {
        ref = latest.ref;
      } else if (kind === "started" || kind === "renewed") {
        ref = `test-${randomUUID()}`;
      } else {
        throw new OperatorCommandError("The account has no test subscription: send started first");
      }
    }
    const raw: TestProviderEvent = {
      id: command.eventId ?? `test-event-${randomUUID()}`,
      kind,
      ref,
      accountId,
      at: (command.at ?? new Date()).toISOString(),
      ...(command.periodEnd && { periodEnd: command.periodEnd.toISOString() }),
      ...(command.graceUntil && { graceUntil: command.graceUntil.toISOString() }),
    };
    let event;
    try {
      event = this.provider.parseEvent(raw);
    } catch (error) {
      throw new OperatorCommandError((error as Error).message);
    }
    const received = await this.events.receive("test", event, "operator");
    return {
      ...received,
      kind,
      providerRef: ref,
      eventAt: event.eventAt.toISOString(),
      periodEnd: event.periodEnd?.toISOString() ?? null,
      note: "The worker applies it in a few seconds (pnpm --filter api worker)",
    };
  }

  /** The subscription, its history and the access of a phone number's account. */
  async status(phoneInput: string) {
    return this.views.forAdmin(await this.accountOf(phoneInput));
  }

  /**
   * `dev:payments:webhook` (development and tests only): a webhook of the
   * test payment provider, signed with the configured secret, sent to this
   * deployment's own address — the check of the signature, the receipt, the
   * queue and the applying, without an acquirer. Without a key it names the
   * latest open charge of the company.
   */
  async paymentWebhook(input: {
    key?: string;
    status?: string;
    reason?: string;
    twice: boolean;
    badSignature: boolean;
  }) {
    const secret = this.config.payments.webhookSecret;
    if (!secret) {
      throw new OperatorCommandError("PAYMENT_WEBHOOK_SECRET is not configured");
    }
    const status = input.status ?? "succeeded";
    if (status !== "succeeded" && status !== "declined") {
      throw new OperatorCommandError("--status is succeeded or declined");
    }
    let key = input.key;
    if (!key) {
      const [open] = await this.database.db
        .select({ key: paymentAttempt.idempotencyKey })
        .from(paymentAttempt)
        .where(inArray(paymentAttempt.status, [...openAttemptStatuses]))
        .orderBy(desc(paymentAttempt.createdAt))
        .limit(1);
      if (!open) {
        throw new OperatorCommandError("No charge is waiting for an answer: give --key");
      }
      key = open.key;
    }
    const body = JSON.stringify({
      id: `dev-payment-${randomUUID()}`,
      type: "payment",
      key,
      status,
      ...(status === "declined" ? { reason: input.reason ?? "insufficient_funds" } : {}),
      paymentId: `dev-${randomUUID()}`,
    });
    const url = `http://127.0.0.1:${String(this.config.port)}${PAYMENT_WEBHOOK_PATH}`;
    const signature = signPaymentWebhook(
      input.badSignature ? "a-secret-nobody-configured" : secret,
      body,
    );
    const answers: { status: number; body: string }[] = [];
    for (let i = 0; i < (input.twice ? 2 : 1); i++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PAYMENT_WEBHOOK_SIGNATURE_HEADER]: signature,
        },
        // The same event twice is the same event: the id stays.
        body,
      });
      answers.push({ status: response.status, body: (await response.text()).slice(0, 200) });
    }
    return { url, key, status, deliveries: answers };
  }

  /**
   * `dev:stores:notify` (development and tests only, TASK-041): a store's
   * notification about the account's purchase, signed with the local keys of
   * `apps/api/fixtures/stores` (the server trusts them only in development
   * and tests), sent to this deployment's own address — the check of the
   * signature, the keeping, the worker's applying, the push, without a store.
   *
   * - `--store apple` (default): App Store Server Notifications V2 —
   *   `--type` and `--subtype` as Apple names them (`SUBSCRIBED INITIAL_BUY`,
   *   `DID_FAIL_TO_RENEW GRACE_PERIOD`, `DID_RENEW`, `EXPIRED`…); the
   *   purchase is `--ref` (an original transaction id) or the account's
   *   latest App Store purchase, or a new one; `--until` — the term's end,
   *   `--grace-until` — the grace's end.
   * - `--store google`: a Pub/Sub push of a developer notification (`--type`
   *   — its numeric code, 4 = purchased); Google's notification carries only
   *   a token — the worker reads its state in the Play Developer API, which a
   *   development machine doesn't have: the delivery is kept and waits.
   */
  async storeNotify(input: {
    phone: string;
    store: string;
    type: string;
    subtype?: string;
    until?: Date;
    graceUntil?: Date;
    ref?: string;
    product?: string;
    twice: boolean;
    badSignature: boolean;
  }) {
    const accountId = await this.accountOf(input.phone);
    const plan = await this.plans.inEffect("user", new Date());
    const productId = input.product ?? plan?.storeProductIds[0] ?? "kz.adclub.club.month";
    const answers: { status: number; body: string }[] = [];
    const post = async (url: string, headers: Record<string, string>, body: string) => {
      for (let i = 0; i < (input.twice ? 2 : 1); i++) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        });
        answers.push({ status: response.status, body: (await response.text()).slice(0, 200) });
      }
    };
    const base = `http://127.0.0.1:${String(this.config.port)}`;
    if (input.store === "google") {
      const code = Number(input.type);
      if (!Number.isInteger(code)) {
        throw new OperatorCommandError(
          "--type is the numeric notificationType of Google (4 = purchased)",
        );
      }
      const google = this.config.stores.google;
      const pubsub = google.pubsub!;
      const nowS = Math.floor(Date.now() / 1000);
      const token = devGoogleOidcToken({
        iss: "https://accounts.google.com",
        aud: input.badSignature ? "https://someone-else.example" : pubsub.audience,
        email: pubsub.serviceAccount,
        email_verified: true,
        iat: nowS,
        exp: nowS + 600,
      });
      const purchaseToken = input.ref ?? `dev-token-${randomUUID()}`;
      const body = JSON.stringify(
        devPubsubPush(
          {
            version: "1.0",
            packageName: google.packageName,
            eventTimeMillis: String(Date.now()),
            subscriptionNotification: { version: "1.0", notificationType: code, purchaseToken },
          },
          `dev-message-${randomUUID()}`,
        ),
      );
      await post(`${base}${GOOGLE_STORE_WEBHOOK_PATH}`, { authorization: `Bearer ${token}` }, body);
      return {
        store: "google",
        type: code,
        deliveries: answers,
        note: "Google's notification names only the token: the worker asks the Play Developer API for its state (none on a development machine — the delivery waits)",
      };
    }
    if (input.store !== "apple") throw new OperatorCommandError("--store is apple or google");
    let originalTransactionId = input.ref;
    if (!originalTransactionId) {
      const [latest] = await this.database.db
        .select({ id: storePurchase.originalTransactionId })
        .from(storePurchase)
        .where(and(eq(storePurchase.accountId, accountId), eq(storePurchase.platform, "ios")))
        .orderBy(desc(storePurchase.createdAt))
        .limit(1);
      originalTransactionId =
        latest?.id ?? String(2_000_000_000_000_000 + Math.floor(Math.random() * 1e12));
    }
    const apple = this.config.stores.apple;
    const environment = apple.environments.includes("sandbox") ? "Sandbox" : "Production";
    const now = Date.now();
    // A purchase or a renewal pays a month ahead; any other word is about the term that ends now.
    const paysAhead = ["SUBSCRIBED", "DID_RENEW", "RENEWAL_EXTENDED"].includes(input.type);
    const until = (input.until ?? new Date(paysAhead ? now + 30 * 86_400_000 : now)).getTime();
    const transaction = devAppleJws({
      transactionId: String(now),
      originalTransactionId,
      bundleId: apple.bundleId,
      productId,
      type: "Auto-Renewable Subscription",
      purchaseDate: now,
      expiresDate: until,
      signedDate: now,
      environment,
      appAccountToken: accountId,
      ...(input.type === "REFUND" && { revocationDate: now }),
    });
    const renewal = devAppleJws({
      originalTransactionId,
      autoRenewStatus: input.subtype === "AUTO_RENEW_DISABLED" ? 0 : 1,
      ...(input.graceUntil && { gracePeriodExpiresDate: input.graceUntil.getTime() }),
      signedDate: now,
      environment,
    });
    const signedPayload = devAppleJws(
      {
        notificationType: input.type,
        ...(input.subtype && { subtype: input.subtype }),
        notificationUUID: randomUUID(),
        version: "2.0",
        signedDate: now,
        data: {
          bundleId: apple.bundleId,
          environment,
          signedTransactionInfo: transaction,
          signedRenewalInfo: renewal,
        },
      },
      input.badSignature ? "rogue" : "dev",
    );
    await post(`${base}${APPLE_STORE_WEBHOOK_PATH}`, {}, JSON.stringify({ signedPayload }));
    return {
      store: "apple",
      type: input.subtype ? `${input.type}/${input.subtype}` : input.type,
      originalTransactionId,
      productId,
      deliveries: answers,
      note: "The worker applies it in a few seconds (pnpm --filter api worker)",
    };
  }
}
