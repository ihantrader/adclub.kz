import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { normalizeKzMobilePhone, providerEventKinds, type ProviderEventKind } from "@adclub/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import { PAYMENT_WEBHOOK_PATH } from "../../common/http";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { AccountStore, OperatorCommandError } from "../identity";
import { openAttemptStatuses, paymentAttempt, subscription } from "./schema";
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
}
