import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CardBindingFailure, SupplierCardBinding } from "@adclub/contracts";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { ApiException, serviceUnavailableException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import type { AuditActorRecord } from "../audit";
import { supplier, supplierMember } from "../identity";
import { AppSettings } from "../settings";
import { finishCardBindingJob } from "./billing-jobs";
import { Plans } from "./plans.service";
import { NoPlanError, PaymentCharger } from "./payment-charger";
import { cardExpired, PaymentMethods } from "./payment-methods";
import {
  PaymentProvider,
  PaymentProviderUnavailableError,
  type BoundCard,
} from "./payment-provider";
import { PaymentTokenVault, tokenContext } from "./payment-token-vault";
import { cardBinding, subscription, type CardBindingRow, type PaymentProviderName } from "./schema";

const OPEN_STATUSES = ["pending", "card_received", "charging"] as const;

function bindingActor(
  supplierId: string,
  memberId: string | null,
  accountId: string | null,
): AuditActorRecord {
  return memberId && accountId
    ? { role: "supplier", accountId, supplierId, memberId }
    : { role: "system" };
}

/**
 * A company's trip to the provider's page for a card, and back (SCREENS
 * S-BILL-01; ARCHITECTURE 9.4.2, 4.77; TASK-042). The person never types the
 * card here: the cabinet sends the browser to the provider's page, the
 * provider tells us a token (a webhook, or on the test provider the page
 * itself), and the browser comes back to the cabinet with the binding's id.
 *
 * A binding is born `pending`; the card named by the provider makes it
 * `card_received` (the token sealed at once). What follows is decided in a
 * job, `finish`:
 *
 * - **the company has a subscription** (current, in whatever status): the new
 *   card replaces the old one and nothing is charged — changing the card of a
 *   subscription that is past due is not paying it;
 * - **it has none**: the first charge follows (`charging`) — success is the
 *   card linked and the subscription begun, a refusal is *no card and no
 *   subscription* with the reason in words (`declined`).
 *
 * One trip is open per company at a time (a unique index): asking again
 * returns the open one. A page nobody came back from is `abandoned` after
 * `billing_binding_minutes`.
 */
@Injectable()
export class CardBindings {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
    @Inject(PaymentTokenVault) private readonly vault: PaymentTokenVault,
    @Inject(PaymentMethods) private readonly methods: PaymentMethods,
    @Inject(PaymentCharger) private readonly charger: PaymentCharger,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------ the cabinet

  async start(
    supplierId: string,
    memberId: string,
    returnUrl: string,
  ): Promise<{ binding: CardBindingRow; redirectUrl: string }> {
    const target = this.checkedReturnUrl(returnUrl);
    const minutes = await this.settings.get("billing_binding_minutes");
    let opened: { binding: CardBindingRow; reused: boolean };
    try {
      opened = await this.database.db.transaction(async (tx) => {
        const [company] = await tx
          .select({ id: supplier.id, name: supplier.name })
          .from(supplier)
          .where(eq(supplier.id, supplierId))
          .for("update");
        if (!company) throw new ApiException(404, "NOT_FOUND", "No such supplier");
        await tx
          .update(cardBinding)
          .set({
            status: "abandoned",
            failure: "expired",
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(cardBinding.supplierId, supplierId),
              inArray(cardBinding.status, ["pending", "card_received"]),
              sql`${cardBinding.expiresAt} <= now()`,
            ),
          );
        const [open] = await tx
          .select()
          .from(cardBinding)
          .where(
            and(
              eq(cardBinding.supplierId, supplierId),
              inArray(cardBinding.status, [...OPEN_STATUSES]),
            ),
          );
        if (open) return { binding: open, reused: true };
        const [current] = await tx
          .select({ id: subscription.id })
          .from(subscription)
          .where(and(eq(subscription.supplierId, supplierId), ne(subscription.status, "expired")));
        if (!current && !(await this.plans.inEffect("supplier", new Date(), tx))) {
          throw new NoPlanError();
        }
        const id = randomUUID();
        const [created] = await tx
          .insert(cardBinding)
          .values({
            id,
            supplierId,
            provider: this.provider.name,
            providerRef: `pending:${id}`,
            returnUrl: `${target}${target.includes("?") ? "&" : "?"}binding=${id}`,
            startedByMemberId: memberId,
            expiresAt: sql`now() + make_interval(mins => ${minutes})`,
          })
          .returning();
        return { binding: created!, reused: false };
      });
    } catch (error) {
      if (error instanceof NoPlanError) {
        await this.charger.signalMissingPlan();
        throw new ApiException(409, "BILLING_NO_PLAN", "No tariff for suppliers is recorded");
      }
      throw error;
    }
    if (opened.reused) {
      return { binding: opened.binding, redirectUrl: opened.binding.redirectUrl ?? "" };
    }
    // The provider is asked with nothing locked and nothing open.
    const [company] = await this.database.db
      .select({ name: supplier.name })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    try {
      const page = await this.provider.beginCardBinding({
        orderId: opened.binding.id,
        returnUrl: opened.binding.returnUrl,
        supplierName: company?.name ?? "",
      });
      const [updated] = await this.database.db
        .update(cardBinding)
        .set({
          providerRef: page.providerRef,
          redirectUrl: page.redirectUrl,
          updatedAt: sql`now()`,
        })
        .where(eq(cardBinding.id, opened.binding.id))
        .returning();
      return { binding: updated!, redirectUrl: page.redirectUrl };
    } catch (error) {
      await this.database.db
        .update(cardBinding)
        .set({
          status: "failed",
          failure: "provider_unavailable",
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(cardBinding.id, opened.binding.id));
      this.logger.warn(
        `The provider's page could not be opened supplier=${supplierId} ${error instanceof PaymentProviderUnavailableError ? "unavailable" : "error"}`,
      );
      throw serviceUnavailableException();
    }
  }

  /** The address the provider sends the browser back to must be the cabinet's own. */
  private checkedReturnUrl(returnUrl: string): string {
    let url: URL;
    try {
      url = new URL(returnUrl);
    } catch {
      throw new ApiException(400, "BILLING_RETURN_URL_INVALID", "The return address is not valid");
    }
    const allowed = this.config.http.webOrigins.supplierWeb;
    if (!allowed.includes(url.origin) || url.username || url.password) {
      throw new ApiException(
        400,
        "BILLING_RETURN_URL_INVALID",
        "The return address must be an address of the cabinet",
      );
    }
    url.searchParams.delete("binding");
    url.hash = "";
    return url.toString();
  }

  /** The trip by the provider's own id of it (the test provider's page). */
  async byRef(provider: PaymentProviderName, providerRef: string): Promise<CardBindingRow | null> {
    const [row] = await this.database.db
      .select()
      .from(cardBinding)
      .where(and(eq(cardBinding.provider, provider), eq(cardBinding.providerRef, providerRef)));
    return row ?? null;
  }

  /** The binding of the company (another company's is as missing as an unknown one). */
  async get(supplierId: string, bindingId: string): Promise<CardBindingRow> {
    const [row] = await this.database.db
      .select()
      .from(cardBinding)
      .where(and(eq(cardBinding.id, bindingId), eq(cardBinding.supplierId, supplierId)));
    if (!row) throw new ApiException(404, "NOT_FOUND", "No such card binding");
    return row;
  }

  async view(row: CardBindingRow): Promise<SupplierCardBinding> {
    const [current] = await this.database.db
      .select({ status: subscription.status })
      .from(subscription)
      .where(and(eq(subscription.supplierId, row.supplierId), ne(subscription.status, "expired")));
    const card =
      row.status === "completed" && row.cardMask && row.cardBrand
        ? {
            mask: row.cardMask,
            brand: row.cardBrand,
            expMonth: row.cardExpMonth!,
            expYear: row.cardExpYear!,
            expired: cardExpired({ expMonth: row.cardExpMonth!, expYear: row.cardExpYear! }),
            linkedAt: (row.finishedAt ?? row.updatedAt).toISOString(),
          }
        : null;
    return {
      id: row.id,
      status: row.status,
      failure: (row.failure as CardBindingFailure | null) ?? null,
      card,
      subscriptionStatus:
        current && current.status !== "expired"
          ? (current.status as SupplierCardBinding["subscriptionStatus"])
          : null,
      startedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  // ------------------------------------------------------------ the provider's word

  /** The provider named the card of a trip (its page, or its webhook). */
  async cardReported(
    provider: PaymentProviderName,
    providerRef: string,
    card: BoundCard,
  ): Promise<"applied" | "stale" | "unknown_reference"> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(cardBinding)
        .where(and(eq(cardBinding.provider, provider), eq(cardBinding.providerRef, providerRef)))
        .for("update");
      if (!row) return "unknown_reference" as const;
      if (row.status !== "pending") return "stale" as const;
      await tx
        .update(cardBinding)
        .set({
          status: "card_received",
          cardTokenSealed: this.vault.seal(tokenContext.cardBinding(row.id), card.token),
          cardMask: card.mask,
          cardBrand: card.brand,
          cardExpMonth: card.expMonth,
          cardExpYear: card.expYear,
          updatedAt: sql`now()`,
        })
        .where(eq(cardBinding.id, row.id));
      await this.queue.enqueue(
        finishCardBindingJob,
        { bindingId: row.id },
        { tx, singletonKey: row.id },
      );
      return "applied" as const;
    });
  }

  /** The person left the provider's page without a card. */
  async cancelled(
    provider: PaymentProviderName,
    providerRef: string,
  ): Promise<"applied" | "stale" | "unknown_reference"> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(cardBinding)
        .where(and(eq(cardBinding.provider, provider), eq(cardBinding.providerRef, providerRef)))
        .for("update");
      if (!row) return "unknown_reference" as const;
      if (row.status !== "pending") return "stale" as const;
      await tx
        .update(cardBinding)
        .set({
          status: "abandoned",
          failure: "cancelled",
          finishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(cardBinding.id, row.id));
      return "applied" as const;
    });
  }

  // ------------------------------------------------------------ the job

  /** `billing.finish-binding`: a card the provider named — replace the card, or make the first charge. */
  async finish(bindingId: string): Promise<void> {
    const attemptId = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(cardBinding)
        .where(eq(cardBinding.id, bindingId))
        .for("update");
      if (!row || row.status !== "card_received" || !row.cardTokenSealed) return null;
      await tx
        .select({ id: supplier.id })
        .from(supplier)
        .where(eq(supplier.id, row.supplierId))
        .for("update");
      const [current] = await tx
        .select({ id: subscription.id })
        .from(subscription)
        .where(
          and(eq(subscription.supplierId, row.supplierId), ne(subscription.status, "expired")),
        );
      if (current) {
        await this.replaceCard(tx, row);
        return null;
      }
      try {
        const attempt = await this.charger.openFirst(tx, row, new Date());
        await tx
          .update(cardBinding)
          .set({ status: "charging", updatedAt: sql`now()` })
          .where(eq(cardBinding.id, row.id));
        await this.charger.schedule(attempt.id, tx);
        return attempt.id;
      } catch (error) {
        if (!(error instanceof NoPlanError)) throw error;
        await tx
          .update(cardBinding)
          .set({
            status: "failed",
            failure: "cancelled",
            finishedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(cardBinding.id, row.id));
        return "no_plan" as const;
      }
    });
    if (attemptId === "no_plan") await this.charger.signalMissingPlan();
  }

  private async replaceCard(tx: DbExecutor, row: CardBindingRow): Promise<void> {
    const token = this.vault.open(tokenContext.cardBinding(row.id), row.cardTokenSealed!);
    let accountId: string | null = null;
    if (row.startedByMemberId) {
      const [member] = await tx
        .select({ accountId: supplierMember.accountId })
        .from(supplierMember)
        .where(eq(supplierMember.id, row.startedByMemberId));
      accountId = member?.accountId ?? null;
    }
    const { method } = await this.methods.link(tx, {
      supplierId: row.supplierId,
      provider: row.provider,
      token,
      mask: row.cardMask!,
      brand: row.cardBrand!,
      expMonth: row.cardExpMonth!,
      expYear: row.cardExpYear!,
      bindingId: row.id,
      memberId: row.startedByMemberId,
      actor: bindingActor(row.supplierId, row.startedByMemberId, accountId),
    });
    await tx
      .update(cardBinding)
      .set({
        status: "completed",
        paymentMethodId: method.id,
        cardTokenSealed: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(cardBinding.id, row.id));
  }

  // ------------------------------------------------------------ the sweeper

  /**
   * `billing.expire-bindings`: pages nobody came back from are over; the
   * token of a trip that ended without a card is forgotten at the provider and
   * dropped (a refused first charge left it, the provider holds it too).
   */
  async expire(): Promise<{ expired: number; cleaned: number }> {
    const expired = await this.database.db
      .update(cardBinding)
      .set({
        status: "abandoned",
        failure: "expired",
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(inArray(cardBinding.status, ["pending"]), sql`${cardBinding.expiresAt} <= now()`))
      .returning({ id: cardBinding.id });
    const leftover = await this.database.db
      .select()
      .from(cardBinding)
      .where(
        and(
          inArray(cardBinding.status, ["declined", "failed", "abandoned"]),
          isNotNull(cardBinding.cardTokenSealed),
        ),
      )
      .limit(20);
    let cleaned = 0;
    for (const row of leftover) {
      try {
        await this.provider.detachCard(
          this.vault.open(tokenContext.cardBinding(row.id), row.cardTokenSealed!),
        );
        await this.database.db
          .update(cardBinding)
          .set({ cardTokenSealed: null, updatedAt: sql`now()` })
          .where(eq(cardBinding.id, row.id));
        cleaned += 1;
      } catch {
        // The provider is not there: the next minute tries again.
      }
    }
    return { expired: expired.length, cleaned };
  }
}
