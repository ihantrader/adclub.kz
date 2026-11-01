import { randomUUID } from "node:crypto";
import {
  Controller,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { PAYMENT_WEBHOOK_PATH } from "../../common/http";
import { DatabaseService } from "../../database";
import { JobQueue } from "../../jobs";
import { Metrics } from "../../observability";
import { RateLimitedNonContractRoute } from "../../rate-limit";
import { applyPaymentWebhookJob } from "./billing-jobs";
import { CardBindings } from "./card-bindings";
import { PaymentCharger } from "./payment-charger";
import {
  PaymentProvider,
  PaymentWebhookError,
  type ParsedPaymentWebhook,
} from "./payment-provider";
import { PaymentTokenVault, tokenContext } from "./payment-token-vault";
import { paymentWebhookEvent } from "./schema";

/** Waiting longer than this, a delivery has lost its job: `billing.resolve-attempts` puts it back. */
const WAKE_AFTER_SECONDS = 60;

/** The result of a delivery whose card is still to be forgotten at the provider (I840). */
const DETACH_PENDING = "detach_pending";

/**
 * What the payment provider tells us (TASK-042; ARCHITECTURE 4.77): a card
 * named for a trip, a trip left without one, the result of a charge. Kept
 * once by the provider's own id of the event; applied by the worker, in any
 * order and any number of times — each part of the application is itself
 * idempotent (a binding takes a card once; an attempt is settled once and a
 * later word about it changes nothing), so a delivery that arrives before
 * the answer to the charge, after it, twice, or on a paused company, ends
 * the same.
 *
 * A card's token in a delivery is sealed before the delivery is kept.
 */
@Injectable()
export class PaymentWebhooks {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
    @Inject(PaymentTokenVault) private readonly vault: PaymentTokenVault,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(CardBindings) private readonly bindings: CardBindings,
    @Inject(PaymentCharger) private readonly charger: PaymentCharger,
  ) {}

  /** Keeps a verified delivery and puts it on the queue; a repeat of one changes nothing. */
  async receive(rawBody: Buffer): Promise<{ stored: boolean; kind: string }> {
    let event: ParsedPaymentWebhook;
    try {
      event = this.provider.parseWebhook(rawBody);
    } catch (error) {
      if (error instanceof PaymentWebhookError) {
        this.logger.warn(`A payment webhook that is not one: ${error.message}`);
        return { stored: false, kind: "malformed" };
      }
      throw error;
    }
    if (event.kind === "ignored") return { stored: false, kind: "ignored" };
    const id = randomUUID();
    const payload: Record<string, unknown> =
      event.kind === "card_bound"
        ? {
            providerRef: event.providerRef,
            card: {
              tokenSealed: this.vault.seal(tokenContext.webhookEvent(id), event.card.token),
              mask: event.card.mask,
              brand: event.card.brand,
              expMonth: event.card.expMonth,
              expYear: event.card.expYear,
            },
          }
        : event.kind === "card_cancelled"
          ? { providerRef: event.providerRef }
          : {
              idempotencyKey: event.idempotencyKey,
              result: event.result,
              reason: event.reason,
              providerPaymentId: event.providerPaymentId,
            };
    const stored = await this.database.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(paymentWebhookEvent)
        .values({
          id,
          provider: this.provider.name,
          providerEventId: event.eventId,
          kind: event.kind,
          payload,
        })
        .onConflictDoNothing({
          target: [paymentWebhookEvent.provider, paymentWebhookEvent.providerEventId],
        })
        .returning({ id: paymentWebhookEvent.id });
      if (!inserted) return false;
      await this.queue.enqueue(
        applyPaymentWebhookJob,
        { eventId: inserted.id },
        { tx, singletonKey: inserted.id },
      );
      return true;
    });
    return { stored, kind: event.kind };
  }

  /** `billing.apply-payment-webhook`: one delivery. */
  async apply(eventId: string): Promise<void> {
    const [row] = await this.database.db
      .select()
      .from(paymentWebhookEvent)
      .where(eq(paymentWebhookEvent.id, eventId));
    if (!row || row.processedAt) return;
    let result: string;
    const payload = row.payload;
    switch (row.kind) {
      case "card_bound": {
        const card = payload.card as {
          tokenSealed: string;
          mask: string;
          brand: "visa" | "mastercard" | "other";
          expMonth: number;
          expYear: number;
        };
        const token = this.vault.open(tokenContext.webhookEvent(row.id), card.tokenSealed);
        result = await this.bindings.cardReported(row.provider, String(payload.providerRef), {
          token,
          mask: card.mask,
          brand: card.brand,
          expMonth: card.expMonth,
          expYear: card.expYear,
        });
        if (result === "foreign_card") {
          // A card nobody will charge: forgotten at the provider now, or — if
          // it is away — by `detachLeftovers` each minute until it is (I840).
          // Until then the delivery keeps the sealed token, and only it.
          if (await this.forget(token)) {
            result = "card_detached";
          } else {
            await this.database.db
              .update(paymentWebhookEvent)
              .set({ processedAt: sql`now()`, result: DETACH_PENDING })
              .where(eq(paymentWebhookEvent.id, row.id));
            this.logger.warn(`A card of a trip that is over waits to be detached event=${row.id}`);
            return;
          }
        }
        break;
      }
      case "card_cancelled":
        result = await this.bindings.cancelled(row.provider, String(payload.providerRef));
        break;
      case "payment": {
        const key = String(payload.idempotencyKey);
        const providerPaymentId = (payload.providerPaymentId as string | null) ?? null;
        result =
          payload.result === "succeeded"
            ? await this.charger.settleByKey(key, { kind: "succeeded", providerPaymentId })
            : await this.charger.settleByKey(key, {
                kind: "declined",
                reason: (payload.reason as never) ?? "declined_other",
                providerPaymentId,
              });
        break;
      }
    }
    await this.database.db
      .update(paymentWebhookEvent)
      .set({
        processedAt: sql`now()`,
        result: result === "applied" ? "applied" : result === "stale" ? "no_effect" : result,
        // A card's sealed token is of no use once applied.
        payload: row.kind === "card_bound" ? { providerRef: payload.providerRef } : payload,
      })
      .where(eq(paymentWebhookEvent.id, row.id));
    this.logger.log(`Payment webhook applied event=${row.id} kind=${row.kind} result=${result}`);
  }

  private async forget(token: string): Promise<boolean> {
    try {
      await this.provider.detachCard(token);
      return true;
    } catch {
      return false;
    }
  }

  /** `billing.resolve-attempts`: cards of trips that were over, forgotten at the provider at last. */
  async detachLeftovers(): Promise<number> {
    const rows = await this.database.db
      .select()
      .from(paymentWebhookEvent)
      .where(eq(paymentWebhookEvent.result, DETACH_PENDING))
      .orderBy(asc(paymentWebhookEvent.receivedAt))
      .limit(50);
    let detached = 0;
    for (const row of rows) {
      const card = row.payload.card as { tokenSealed: string } | undefined;
      const done =
        !card ||
        (await this.forget(this.vault.open(tokenContext.webhookEvent(row.id), card.tokenSealed)));
      if (!done) continue;
      await this.database.db
        .update(paymentWebhookEvent)
        .set({ result: "card_detached", payload: { providerRef: row.payload.providerRef } })
        .where(eq(paymentWebhookEvent.id, row.id));
      detached += 1;
    }
    return detached;
  }

  /** Deliveries nobody applied for a minute go back on the queue. */
  async wake(): Promise<number> {
    const rows = await this.database.db
      .select({ id: paymentWebhookEvent.id })
      .from(paymentWebhookEvent)
      .where(
        and(
          isNull(paymentWebhookEvent.processedAt),
          lt(
            paymentWebhookEvent.receivedAt,
            sql`now() - make_interval(secs => ${WAKE_AFTER_SECONDS})`,
          ),
        ),
      )
      .orderBy(asc(paymentWebhookEvent.receivedAt))
      .limit(200);
    for (const row of rows) {
      await this.queue.enqueue(
        applyPaymentWebhookJob,
        { eventId: row.id },
        { singletonKey: row.id },
      );
    }
    return rows.length;
  }
}

/**
 * Where the payment provider reports a card and a charge (TASK-042).
 * Outside the client contract, like the message provider's webhook, and with
 * the same discipline: **the signature is checked first, over the bytes as
 * they came, before anything of the body is read**; a body without a
 * signature or with a foreign one is a 403 and leaves nothing in the
 * database; once the signature is right the answer is 200 whatever the body
 * turns out to hold, so the provider does not repeat what it cannot mend.
 */
@Controller()
export class PaymentWebhookController {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
    @Inject(PaymentWebhooks) private readonly webhooks: PaymentWebhooks,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  @Post(PAYMENT_WEBHOOK_PATH)
  @HttpCode(200)
  @Header("cache-control", "no-store")
  @RateLimitedNonContractRoute({ limit: "payment_webhook_per_ip", whenUnavailable: "allow" })
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    if (!this.provider.verifyWebhook(body, headers)) {
      this.metrics.countWebhookEvent("bad_signature");
      // Neither the body nor the signature is logged; the body is not parsed.
      this.logger.warn("Payment webhook refused: the signature does not match");
      throw new ApiException(403, "FORBIDDEN", "The signature does not match");
    }
    if (body.length === 0) {
      this.metrics.countWebhookEvent("empty");
      return { received: true };
    }
    await this.webhooks.receive(body);
    return { received: true };
  }
}
