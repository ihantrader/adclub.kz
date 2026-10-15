import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { normalizeKzMobilePhone, providerEventKinds, type ProviderEventKind } from "@adclub/domain";
import { and, desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { AccountStore, OperatorCommandError } from "../identity";
import { subscription } from "./schema";
import { SubscriptionEvents } from "./subscription-events";
import { TestSubscriptionProvider, type TestProviderEvent } from "./subscription-provider";
import { SubscriptionViews } from "./subscription-views";

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
}
