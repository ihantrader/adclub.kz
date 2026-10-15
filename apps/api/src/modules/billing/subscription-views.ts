import { Inject, Injectable } from "@nestjs/common";
import type {
  AdminUserSubscription,
  AdminUserSubscriptionResponse,
  MySubscription,
  MySubscriptionResponse,
  SubscriptionHistoryEntry,
  SupplierSubscriptionResponse,
} from "@adclub/contracts";
import { subscriptionAccess } from "@adclub/domain";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { ClubAccess, type ClubAccessSources } from "../club-access";
import { account, supplier } from "../identity";
import { supplierCardRequired } from "../offers";
import { AppSettings } from "../settings";
import { Plans } from "./plans.service";
import { billingEvent, subscription, type BillingEventRow, type SubscriptionRow } from "./schema";

const HOUR_MS = 3_600_000;
const HISTORY_LIMIT = 100;

type Language = "kk" | "ru" | "en";

function mine(
  row: SubscriptionRow,
  sources: { granted: boolean; until: Date | null },
): MySubscription {
  return {
    status: row.status,
    grantsAccess: sources.granted,
    statusConfirmed: row.status !== "expired_unconfirmed",
    periodEnd: row.currentPeriodEnd.toISOString(),
    accessUntil: sources.until?.toISOString() ?? null,
    graceUntil: row.graceUntil?.toISOString() ?? null,
    provider: row.provider,
    platform: row.purchasePlatform,
  };
}

function manualGrant(sources: ClubAccessSources) {
  return sources.manualUntil ? { validUntil: sources.manualUntil.toISOString() } : null;
}

function historyEntry(row: BillingEventRow): SubscriptionHistoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    by: row.source,
    eventAt: row.eventAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    outcome: row.outcome,
    detail: row.detail,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    periodEnd: row.payload.periodEnd ?? null,
  };
}

/**
 * What a subscription looks like to whom (TASK-040; ARCHITECTURE 4.72): the
 * owner on any device (`GET /me/subscription`, M-SUB-02), the company in its
 * cabinet (D-041 and its tariff, S-BILL-01 comes with TASK-042), the
 * administrator (A-USR-02 «Клубный доступ»). Access is read only through
 * `ClubAccess`.
 */
@Injectable()
export class SubscriptionViews {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async mine(accountId: string, language: Language): Promise<MySubscriptionResponse> {
    const now = new Date();
    const [sources, screens] = await Promise.all([
      this.clubAccess.sourcesOf(accountId, this.database.db, now),
      this.plans.forScreens("user", language, now),
    ]);
    return {
      subscription: sources.subscription
        ? mine(sources.subscription, sources.subscriptionAccess)
        : null,
      access: sources.access,
      manualGrant: manualGrant(sources),
      ...screens,
    };
  }

  async ofSupplier(supplierId: string, language: Language): Promise<SupplierSubscriptionResponse> {
    const [[company], cardRequired, screens] = await Promise.all([
      this.database.db
        .select({ cardLinkedAt: supplier.cardLinkedAt })
        .from(supplier)
        .where(eq(supplier.id, supplierId)),
      // As the rule of the showcase reads it, so the words match what clients see.
      supplierCardRequired(this.database.db),
      this.plans.forScreens("supplier", language),
    ]);
    const cardLinked = Boolean(company?.cardLinkedAt);
    return {
      cardLinked,
      cardRequired,
      hiddenWithoutCard: cardRequired && !cardLinked,
      ...screens,
    };
  }

  async forAdmin(accountId: string): Promise<AdminUserSubscriptionResponse> {
    const now = new Date();
    const [person] = await this.database.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, accountId));
    if (!person) {
      throw new ApiException(404, "NOT_FOUND", "No such user");
    }
    const [sources, rows, toleranceHours] = await Promise.all([
      this.clubAccess.sourcesOf(accountId, this.database.db, now),
      this.database.db
        .select()
        .from(subscription)
        .where(and(eq(subscription.accountId, accountId), eq(subscription.audience, "user")))
        .orderBy(desc(subscription.createdAt)),
      this.settings.get("store_lag_tolerance_hours"),
    ]);
    const shown = sources.subscription ?? rows[0] ?? null;
    const ids = rows.map((row) => row.id);
    // The events naming the account (a purchase it brought, time's events)
    // and those of its subscriptions that name only the purchase.
    const history = await this.database.db
      .select()
      .from(billingEvent)
      .where(
        or(
          eq(billingEvent.accountId, accountId),
          ids.length > 0 ? inArray(billingEvent.subscriptionId, ids) : undefined,
        ),
      )
      .orderBy(desc(billingEvent.receivedAt), desc(billingEvent.eventAt))
      .limit(HISTORY_LIMIT);
    let view: AdminUserSubscription | null = null;
    if (shown) {
      const access = subscriptionAccess(
        {
          status: shown.status,
          periodEnd: shown.currentPeriodEnd,
          graceUntil: shown.graceUntil,
          unconfirmedSince: shown.unconfirmedSince,
        },
        now,
        toleranceHours * HOUR_MS,
      );
      view = {
        ...mine(shown, access),
        id: shown.id,
        providerRef: shown.providerRef,
        createdAt: shown.createdAt.toISOString(),
        updatedAt: shown.updatedAt.toISOString(),
      };
    }
    return {
      subscription: view,
      history: history.map(historyEntry),
      access: sources.access,
      manualGrant: manualGrant(sources),
    };
  }
}
