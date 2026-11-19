import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  APP_STORE_SUBJECT_ID,
  GOOGLE_PLAY_SUBJECT_ID,
  type StoreSyncBody,
} from "@adclub/contracts";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { ApiException } from "../../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../../config";
import { afterCommit, DatabaseService, type DbExecutor } from "../../../database";
import { JobQueue } from "../../../jobs";
import { account } from "../../identity";
import { Notifications } from "../../notifications";
import { AppSettings } from "../../settings";
import { AdminSignals } from "../../signals";
import { applyStoreNotificationJob } from "../billing-jobs";
import { Plans } from "../plans.service";
import {
  billingEvent,
  storeApiHealth,
  storeNotification,
  storePurchase,
  subscription,
  type StorePlatform,
  type StorePurchaseRow,
} from "../schema";
import { SubscriptionEvents } from "../subscription-events";
import { AppStore } from "./app-store";
import { StoreFetch } from "./store-fetch";
import { googleRef, GooglePlay } from "./google-play";
import { StorePurchaseRefusedError, StoreUnavailableError, type StoreWord } from "./store-word";

const HOUR_MS = 3_600_000;

/** A delivery whose job hasn't run this long is put on the queue again. */
const WAKE_AFTER_SECONDS = 120;
/** A purchase asked less than this long ago is not asked again by the reconciliation. */
const RESYNC_AFTER_MS = 30 * 60_000;

/** The refusals of `billing_event` a `sync` answers with its own code. */
const syncRefusals: Record<
  string,
  {
    code:
      | "SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT"
      | "SUBSCRIPTION_ALREADY_ACTIVE"
      | "SUBSCRIPTION_PRODUCT_UNKNOWN";
    message: string;
  }
> = {
  linked_to_another_account: {
    code: "SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT",
    message: "The purchase belongs to another account",
  },
  already_active: {
    code: "SUBSCRIPTION_ALREADY_ACTIVE",
    message: "Another subscription of the account is in force",
  },
  unknown_product: {
    code: "SUBSCRIPTION_PRODUCT_UNKNOWN",
    message: "The product is not one of the tariff",
  },
};

const storeSubject: Record<StorePlatform, string> = {
  ios: APP_STORE_SUBJECT_ID,
  android: GOOGLE_PLAY_SUBJECT_ID,
};

/**
 * The stores' side of a user's subscription (TASK-041; ARCHITECTURE 9.4.1,
 * 4.98). Everything a store says — a purchase checked by `sync`, a
 * notification, a state the reconciliation asked for — becomes events of
 * `billing_event` through `SubscriptionEvents.receive`, the one way a
 * subscription changes (TASK-040): the same table of moves, the same
 * journal, the same rule «whose purchase». Nothing here sets a status.
 *
 * The client's word is never taken: `sync` reads only what the store signs
 * or answers. Tokens of purchases and signed payloads are never logged.
 */
@Injectable()
export class StoreSubscriptions {
  private readonly logger = new Logger("Billing");
  readonly apple: AppStore;
  readonly google: GooglePlay;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(SubscriptionEvents) private readonly events: SubscriptionEvents,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(Notifications) private readonly notifications: Notifications,
    @Inject(StoreFetch) fetch: StoreFetch,
  ) {
    const call = (input: string, init: RequestInit) => fetch.fetch(input, init);
    this.apple = new AppStore(config.stores.apple, call);
    this.google = new GooglePlay(config.stores.google, call);
  }

  // ------------------------------------------------------------------ health

  /** Every call of a store's API leaves its mark: the signal reads it. */
  private async health(
    platform: StorePlatform,
    error: StoreUnavailableError | null,
  ): Promise<void> {
    const at = new Date();
    await this.database.db
      .insert(storeApiHealth)
      .values({
        platform,
        ...(error ? { lastFailureAt: at, lastFailure: error.reason } : { lastSuccessAt: at }),
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: storeApiHealth.platform,
        set: error
          ? { lastFailureAt: at, lastFailure: error.reason, updatedAt: at }
          : { lastSuccessAt: at, updatedAt: at },
      });
  }

  /** A call of a store's API, with its mark. */
  private async asking<T>(platform: StorePlatform, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      await this.health(platform, null);
      return result;
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        if (error.reason !== "not_configured") await this.health(platform, error);
        this.logger.warn(`Store API unavailable platform=${platform} reason=${error.reason}`);
      }
      throw error;
    }
  }

  private async purchaseState(
    row: Pick<
      StorePurchaseRow,
      "platform" | "originalTransactionId" | "purchaseToken" | "environment" | "productId"
    >,
  ): Promise<StoreWord | null> {
    if (row.platform === "ios") {
      return this.asking("ios", () =>
        this.apple.state(row.originalTransactionId!, row.environment),
      );
    }
    return this.asking("android", async () => {
      const state = await this.google.state(row.purchaseToken!, row.productId);
      if (!state) return null;
      await this.acknowledgeIfOurs(state.word, state.acknowledged);
      return state.word;
    });
  }

  // ------------------------------------------------------------- delivering

  /** The store's account, if it is an account of ours (a foreign key can't name nobody). */
  private async knownAccount(tx: DbExecutor, accountId: string | null): Promise<string | null> {
    if (!accountId) return null;
    const [row] = await tx
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, accountId));
    return row ? row.id : null;
  }

  /** Keeps the purchase's facts and the store's word about it. */
  private async keepPurchase(tx: DbExecutor, word: StoreWord, synced: boolean): Promise<void> {
    const facts = word.facts;
    const accountId = await this.knownAccount(tx, facts.accountId);
    const at = new Date();
    await tx
      .insert(storePurchase)
      .values({
        providerRef: facts.providerRef,
        platform: facts.platform,
        environment: facts.environment,
        originalTransactionId: facts.originalTransactionId,
        purchaseToken: facts.purchaseToken,
        productId: facts.productId,
        accountId,
        lastWord: facts.word,
        lastWordAt: facts.wordAt,
        lastSyncAt: synced ? at : null,
      })
      .onConflictDoUpdate({
        target: storePurchase.providerRef,
        set: {
          productId: facts.productId,
          lastWord: facts.word,
          lastWordAt: facts.wordAt,
          ...(accountId && { accountId: sql`coalesce(${storePurchase.accountId}, ${accountId})` }),
          ...(synced && { lastSyncAt: at }),
          updatedAt: at,
        },
      });
  }

  /**
   * The events of a word into `billing_event` (in `tx`), each once by its
   * id; returns the ids of the rows (new or already there).
   */
  private async deliver(tx: DbExecutor, word: StoreWord, synced: boolean): Promise<string[]> {
    await this.keepPurchase(tx, word, synced);
    const ids: string[] = [];
    const accountId = await this.knownAccount(tx, word.facts.accountId);
    for (const event of word.events) {
      let received = await this.events.receive("store", { ...event, accountId }, "provider", tx);
      if (received.duplicate) {
        // The same word again is the same event — unless it was refused
        // (another subscription was in force, the account wasn't named…):
        // what refused it may have changed, so it is judged anew.
        const [earlier] = await tx
          .select({ outcome: billingEvent.outcome })
          .from(billingEvent)
          .where(eq(billingEvent.id, received.eventId));
        if (earlier?.outcome === "refused") {
          received = await this.events.receive(
            "store",
            {
              ...event,
              accountId,
              providerEventId: `${event.providerEventId}:again:${String(Date.now())}`,
            },
            "provider",
            tx,
          );
        }
      }
      ids.push(received.eventId);
    }
    return ids;
  }

  // ------------------------------------------------------------------- sync

  /**
   * `POST /billing/store/sync`: the purchase checked with the store, its
   * state applied now (in this process — the answer must say what came of
   * it), the subscription as `GET /me/subscription` shows it.
   */
  async sync(accountId: string, body: StoreSyncBody): Promise<void> {
    let word: StoreWord | null;
    let linkedOld: string | null = null;
    let googleAcknowledged: boolean | null = null;
    try {
      if (body.platform === "ios") {
        if (!this.apple.canReceive || !this.apple.config.api) {
          throw new StoreUnavailableError("App Store is not configured here", "not_configured");
        }
        const transaction = this.apple.readTransaction(body.signedTransaction);
        this.refuseOtherAccount(transaction.appAccountToken ?? null, accountId);
        await this.refuseUnknownProduct(transaction.productId);
        word = await this.asking("ios", () =>
          this.apple.state(transaction.originalTransactionId, transaction.environmentValue),
        );
      } else {
        if (!this.google.config.api) {
          throw new StoreUnavailableError("Google Play is not configured here", "not_configured");
        }
        const state = await this.asking("android", () =>
          this.google.state(body.purchaseToken, body.productId),
        );
        word = state?.word ?? null;
        if (state) {
          linkedOld = state.linkedPurchaseToken;
          googleAcknowledged = state.acknowledged;
          this.refuseOtherAccount(state.word.facts.accountId, accountId);
          await this.refuseUnknownProduct(state.word.facts.productId);
        }
      }
    } catch (error) {
      throw this.httpError(error);
    }
    if (!word) {
      throw new ApiException(
        400,
        "SUBSCRIPTION_PURCHASE_INVALID",
        "The store does not know this purchase",
        {
          details: { reason: "not_found" },
        },
      );
    }
    // The store names nobody (a purchase made before the account was given to
    // the store): the purchase is claimed by the account that brings it.
    word = { ...word, facts: { ...word.facts, accountId: word.facts.accountId ?? accountId } };
    const ids = await this.database.db.transaction(async (tx) => {
      if (linkedOld) await this.endReplaced(tx, linkedOld, accountId, word!);
      return this.deliver(tx, word!, true);
    });
    if (linkedOld) await this.events.applyPurchase("store", googleRef(linkedOld));
    await this.events.applyPurchase("store", word.facts.providerRef);
    const outcomes = ids.length
      ? await this.database.db
          .select({ outcome: billingEvent.outcome, detail: billingEvent.detail })
          .from(billingEvent)
          .where(inArray(billingEvent.id, ids))
      : [];
    for (const row of outcomes) {
      const refusal =
        row.outcome === "refused" && row.detail ? syncRefusals[row.detail] : undefined;
      if (refusal) throw new ApiException(409, refusal.code, refusal.message);
    }
    if (word.facts.platform === "android" && googleAcknowledged === false) {
      await this.acknowledgeIfOurs(word, false);
    }
  }

  private refuseOtherAccount(named: string | null, accountId: string): void {
    if (named && named.toLowerCase() !== accountId.toLowerCase()) {
      throw new ApiException(
        409,
        "SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT",
        "The purchase belongs to another account",
      );
    }
  }

  private async refuseUnknownProduct(productId: string): Promise<void> {
    const plan = await this.plans.inEffect("user", new Date());
    if (!plan?.storeProductIds.includes(productId)) {
      throw new ApiException(
        409,
        "SUBSCRIPTION_PRODUCT_UNKNOWN",
        "The product is not one of the tariff",
      );
    }
  }

  /**
   * Google: a resubscription or a change of plan is a new token naming the
   * old one (`linkedPurchaseToken`); the old purchase of the same account
   * ends, so the new one finds room (one current subscription per account).
   */
  private async endReplaced(
    tx: DbExecutor,
    oldToken: string,
    accountId: string,
    word: StoreWord,
  ): Promise<void> {
    const ref = googleRef(oldToken);
    const [old] = await tx
      .select({ id: subscription.id })
      .from(subscription)
      .where(
        and(
          eq(subscription.provider, "store"),
          eq(subscription.providerRef, ref),
          eq(subscription.accountId, accountId),
        ),
      );
    if (!old) return;
    await this.events.receive(
      "store",
      {
        providerEventId: `${ref}:replaced-by:${word.facts.providerRef}`,
        kind: "expired",
        providerRef: ref,
        accountId,
        eventAt: new Date(word.facts.wordAt.getTime() - 1),
        periodEnd: null,
        graceUntil: null,
        platform: "android",
      },
      "provider",
      tx,
    );
  }

  private async acknowledgeIfOurs(word: StoreWord, acknowledged: boolean): Promise<void> {
    if (acknowledged || word.facts.platform !== "android") return;
    const [ours] = await this.database.db
      .select({ id: subscription.id })
      .from(subscription)
      .where(
        and(
          eq(subscription.provider, "store"),
          eq(subscription.providerRef, word.facts.providerRef),
        ),
      );
    if (!ours) return;
    try {
      await this.google.acknowledge(word.facts.productId, word.facts.purchaseToken!);
    } catch (error) {
      // Google refunds an unacknowledged purchase in three days; the next
      // word about it (a notification, the reconciliation) tries again.
      this.logger.warn(`Acknowledging a Play purchase failed: ${(error as Error).message}`);
    }
  }

  private httpError(error: unknown): unknown {
    if (error instanceof StorePurchaseRefusedError) {
      return new ApiException(
        400,
        "SUBSCRIPTION_PURCHASE_INVALID",
        "Not a purchase of this app's subscription",
        {
          details: { reason: error.reason },
        },
      );
    }
    if (error instanceof StoreUnavailableError) {
      return new ApiException(
        503,
        "SERVICE_UNAVAILABLE",
        "The store could not be reached, try again later",
        {
          retryable: true,
        },
      );
    }
    return error;
  }

  // ---------------------------------------------------------- notifications

  /**
   * App Store Server Notifications V2: the whole payload checked first; a
   * notification is kept once by its UUID, its event goes to `billing_event`
   * in the same transaction (the worker applies it). Returns what was done.
   */
  async receiveApple(rawBody: Buffer): Promise<{ stored: boolean; result: string }> {
    let signedPayload: string;
    try {
      const body: unknown = JSON.parse(rawBody.toString("utf8"));
      const value = (body as { signedPayload?: unknown } | null)?.signedPayload;
      if (typeof value !== "string") throw new Error("no signedPayload");
      signedPayload = value;
    } catch {
      throw new StorePurchaseRefusedError("Not a notification of the App Store", "malformed");
    }
    const notification = this.apple.readNotification(signedPayload);
    return this.database.db.transaction(async (tx) => {
      const result =
        notification.result === "events" && notification.word
          ? `events:${String(notification.word.events.length)}`
          : notification.result;
      const [kept] = await tx
        .insert(storeNotification)
        .values({
          platform: "ios",
          notificationId: notification.notificationId,
          notificationType: notification.name,
          providerRef: notification.word?.facts.providerRef ?? null,
          eventAt: notification.eventAt,
          processedAt: new Date(),
          result,
        })
        .onConflictDoNothing({
          target: [storeNotification.platform, storeNotification.notificationId],
        })
        .returning({ id: storeNotification.id });
      if (!kept) return { stored: false, result: "duplicate" };
      if (notification.word) await this.deliver(tx, notification.word, false);
      afterCommit(() =>
        this.logger.log(`App Store notification kept type=${notification.name} result=${result}`),
      );
      return { stored: true, result };
    });
  }

  /**
   * Google Play's Pub/Sub push (its token already checked): kept once by
   * the message id, the token beside it until the worker has read the
   * purchase's state.
   */
  async receiveGoogle(body: unknown): Promise<{ stored: boolean; result: string }> {
    const notification = this.google.readPush(body);
    return this.database.db.transaction(async (tx) => {
      const waiting = notification.action === "state" || notification.action === "refunded";
      const [kept] = await tx
        .insert(storeNotification)
        .values({
          platform: "android",
          notificationId: notification.notificationId,
          notificationType: notification.name,
          providerRef: notification.purchaseToken ? googleRef(notification.purchaseToken) : null,
          purchaseToken: waiting ? notification.purchaseToken : null,
          eventAt: notification.eventAt,
          processedAt: waiting ? null : new Date(),
          result: waiting ? null : notification.action,
        })
        .onConflictDoNothing({
          target: [storeNotification.platform, storeNotification.notificationId],
        })
        .returning({ id: storeNotification.id });
      if (!kept) return { stored: false, result: "duplicate" };
      if (waiting) {
        await this.queue.enqueue(
          applyStoreNotificationJob,
          { notificationId: kept.id },
          { tx, singletonKey: kept.id },
        );
      }
      afterCommit(() =>
        this.logger.log(
          `Google Play notification kept type=${notification.name} action=${notification.action}`,
        ),
      );
      return { stored: true, result: notification.action };
    });
  }

  /** `billing.apply-store-notification`: Google's delivery — the purchase's state, said as events. */
  async applyNotification(notificationId: string): Promise<void> {
    const [row] = await this.database.db
      .select()
      .from(storeNotification)
      .where(eq(storeNotification.id, notificationId));
    if (!row || row.processedAt || !row.purchaseToken) return;
    const token = row.purchaseToken;
    let word: StoreWord | null;
    let acknowledged = true;
    if (row.notificationType.startsWith("voided:")) {
      const [known] = await this.database.db
        .select()
        .from(storePurchase)
        .where(eq(storePurchase.providerRef, googleRef(token)));
      word = this.google.refundWord(
        {
          notificationId: row.notificationId,
          name: row.notificationType,
          eventAt: row.eventAt,
          action: "refunded",
          purchaseToken: token,
        },
        known ? { productId: known.productId, environment: known.environment } : null,
      );
    } else {
      // Unavailable — the job's retry (and `billing.watch-stores`) brings it back.
      const state = await this.asking("android", () => this.google.state(token));
      word = state?.word ?? null;
      acknowledged = state?.acknowledged ?? true;
    }
    const result = word ? `events:${String(word.events.length)}` : "no_purchase";
    const delivered = await this.database.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(storeNotification)
        .set({ processedAt: new Date(), result, purchaseToken: null })
        .where(and(eq(storeNotification.id, row.id), isNull(storeNotification.processedAt)))
        .returning({ id: storeNotification.id });
      if (!claimed || !word) return false;
      await this.deliver(tx, word, !row.notificationType.startsWith("voided:"));
      return true;
    });
    if (delivered && word) {
      // Applied here rather than left to the job of the purchase, so a new
      // purchase (its notification came before the app's `sync`) is
      // acknowledged once it is ours — Google refunds what isn't in 3 days.
      await this.events.applyPurchase("store", word.facts.providerRef);
      if (!acknowledged) await this.acknowledgeIfOurs(word, false);
    }
  }

  // ----------------------------------------------------------- reconciling

  /**
   * `billing.reconcile-stores` (hourly): the purchases whose term or grace
   * has passed without a word (or that are held, unconfirmed, cancelled at
   * their end), oldest look first, `store_reconcile_batch` per store; and one
   * more of a store that hasn't answered for an hour, so a quiet store is
   * still known to answer. Each answer goes the way of every word. A store
   * that can't be reached ends its own part of the run, not the other's.
   */
  async reconcile(): Promise<{ asked: number; failed: number }> {
    const batch = await this.settings.get("store_reconcile_batch");
    let asked = 0;
    let failed = 0;
    for (const platform of ["ios", "android"] as const) {
      try {
        const rows = await this.due(platform, batch);
        for (const row of rows) {
          const word = await this.purchaseState(row);
          asked += 1;
          await this.database.db.transaction(async (tx) => {
            if (word) {
              await this.deliver(tx, word, true);
            } else {
              await tx
                .update(storePurchase)
                .set({ lastSyncAt: new Date() })
                .where(eq(storePurchase.providerRef, row.providerRef));
            }
          });
          await this.events.applyPurchase("store", row.providerRef);
        }
      } catch (error) {
        failed += 1;
        if (!(error instanceof StoreUnavailableError)) {
          this.logger.error(
            `Store reconciliation failed platform=${platform}: ${(error as Error).message}`,
          );
        }
      }
    }
    if (asked > 0 || failed > 0) {
      this.logger.log(
        `Store purchases reconciled asked=${String(asked)} failedStores=${String(failed)}`,
      );
    }
    return { asked, failed };
  }

  private async due(platform: StorePlatform, batch: number): Promise<StorePurchaseRow[]> {
    const resync = sql`now() - make_interval(secs => ${RESYNC_AFTER_MS / 1000})`;
    const rows = await this.database.db
      .select({ purchase: storePurchase })
      .from(storePurchase)
      .innerJoin(
        subscription,
        and(
          eq(subscription.provider, "store"),
          eq(subscription.providerRef, storePurchase.providerRef),
        ),
      )
      .where(
        and(
          eq(storePurchase.platform, platform),
          or(isNull(storePurchase.lastSyncAt), lt(storePurchase.lastSyncAt, resync)),
          or(
            and(
              inArray(subscription.status, ["active", "cancelled"]),
              sql`${subscription.currentPeriodEnd} <= now()`,
            ),
            and(eq(subscription.status, "grace"), sql`${subscription.graceUntil} <= now()`),
            eq(subscription.status, "expired_unconfirmed"),
            // Ended by time alone (the tolerance passed without the store's
            // word) within a week: the store may still say «paid», and that
            // restores it backdated (9.4.1 rule 7).
            and(
              eq(subscription.status, "expired"),
              sql`${subscription.updatedAt} > now() - interval '7 days'`,
              sql`(SELECT e.kind FROM billing_event e WHERE e.subscription_id = ${subscription.id}
                   ORDER BY e.applied_at DESC NULLS LAST LIMIT 1) = 'tolerance_lapsed'`,
            ),
          ),
        ),
      )
      .orderBy(sql`${storePurchase.lastSyncAt} NULLS FIRST`, asc(subscription.currentPeriodEnd))
      .limit(batch);
    const due = rows.map((row) => row.purchase);
    if (due.length === 0) {
      const [health] = await this.database.db
        .select()
        .from(storeApiHealth)
        .where(eq(storeApiHealth.platform, platform));
      const quiet = !health?.lastSuccessAt || health.lastSuccessAt.getTime() < Date.now() - HOUR_MS;
      if (quiet) {
        const [oldest] = await this.database.db
          .select({ purchase: storePurchase })
          .from(storePurchase)
          .innerJoin(
            subscription,
            and(
              eq(subscription.provider, "store"),
              eq(subscription.providerRef, storePurchase.providerRef),
            ),
          )
          .where(
            and(eq(storePurchase.platform, platform), sql`${subscription.status} <> 'expired'`),
          )
          .orderBy(sql`${storePurchase.lastSyncAt} NULLS FIRST`)
          .limit(1);
        if (oldest) due.push(oldest.purchase);
      }
    }
    return due;
  }

  // ---------------------------------------------------------------- signal

  /**
   * `billing.watch-stores` (every minute): `store_sync_stale` per store —
   * current subscriptions of the store and no successful call of its API for
   * longer than `store_outage_signal_hours` (since the last success, or since
   * the oldest of those subscriptions when there was none); it closes at the
   * first success. And deliveries whose job was lost go back on the queue.
   */
  async watch(): Promise<{ worked: boolean }> {
    const hours = await this.settings.get("store_outage_signal_hours");
    let worked = false;
    for (const platform of ["ios", "android"] as const) {
      const changed = await this.database.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`billing.watch-stores:${platform}`}))`,
        );
        const at = new Date();
        const [facts] = (
          await tx.execute<{ current: number; oldest: Date | string | null }>(sql`
            SELECT count(*)::int AS current, min(s.created_at) AS oldest
            FROM subscription s JOIN store_purchase p ON p.provider_ref = s.provider_ref
            WHERE s.provider = 'store' AND s.status <> 'expired' AND p.platform = ${platform}
          `)
        ).rows;
        const current = facts?.current ?? 0;
        const [health] = await tx
          .select()
          .from(storeApiHealth)
          .where(eq(storeApiHealth.platform, platform));
        const lastSuccess = health?.lastSuccessAt ?? null;
        const since = lastSuccess ?? (facts?.oldest ? new Date(facts.oldest) : null);
        const stale =
          current > 0 && since !== null && since.getTime() <= at.getTime() - hours * HOUR_MS;
        const subjectId = storeSubject[platform];
        const open = await this.signals.openOf(tx, "store_sync_stale", "channel", subjectId);
        if (stale) {
          const payload = {
            storePlatform: platform,
            since: (open?.payload.since ?? since.toISOString()) || undefined,
            storeLastSuccessAt: lastSuccess?.toISOString() ?? null,
            lastFailureAt: health?.lastFailureAt?.toISOString(),
            storeLastFailure: health?.lastFailure ?? null,
            storeSubscriptions: current,
            storeMissing: this.config.stores.missing[platform === "ios" ? "apple" : "google"],
            windowHours: hours,
          };
          if (
            !open ||
            open.payload.storeSubscriptions !== current ||
            open.payload.lastFailureAt !== payload.lastFailureAt
          ) {
            await this.signals.raise(tx, {
              kind: "store_sync_stale",
              subjectType: "channel",
              subjectId,
              payload,
              at,
            });
            if (!open)
              this.logger.warn(
                `Store API silent platform=${platform} subscriptions=${String(current)}`,
              );
            return true;
          }
          return false;
        }
        if (open) {
          await this.signals.close(tx, {
            kind: "store_sync_stale",
            subjectType: "channel",
            subjectId,
            payload: {
              ...open.payload,
              endedAt: at.toISOString(),
              storeLastSuccessAt: lastSuccess?.toISOString() ?? null,
            },
            at,
          });
          this.logger.log(`Store API answers again platform=${platform}`);
          return true;
        }
        return false;
      });
      worked ||= changed;
    }
    const lost = await this.database.db
      .select({ id: storeNotification.id })
      .from(storeNotification)
      .where(
        and(
          isNull(storeNotification.processedAt),
          lt(
            storeNotification.receivedAt,
            sql`now() - make_interval(secs => ${WAKE_AFTER_SECONDS})`,
          ),
        ),
      )
      .orderBy(asc(storeNotification.receivedAt))
      .limit(200);
    for (const row of lost) {
      await this.queue.enqueue(
        applyStoreNotificationJob,
        { notificationId: row.id },
        { singletonKey: row.id },
      );
    }
    return { worked: worked || lost.length > 0 };
  }

  // -------------------------------------------------------------- reminder

  /**
   * `billing.remind-grace` (every minute): P-SUB-01 again
   * `user_billing_reminder_days` before a store's grace ends — once per grace
   * (`grace_reminded_until` holds the end it was sent for). A subscription
   * paid meanwhile is no longer in `grace`: nothing is sent; one whose
   * reminder was due already when it entered the grace got the first push only.
   */
  async remindGrace(): Promise<number> {
    const days = await this.settings.get("user_billing_reminder_days");
    const ids = await this.database.db
      .select({ id: subscription.id })
      .from(subscription)
      .where(
        and(
          eq(subscription.audience, "user"),
          eq(subscription.status, "grace"),
          sql`${subscription.graceUntil} > now()`,
          sql`${subscription.graceUntil} - make_interval(days => ${days}) <= now()`,
          or(
            isNull(subscription.graceRemindedUntil),
            sql`${subscription.graceRemindedUntil} <> ${subscription.graceUntil}`,
          ),
        ),
      )
      .limit(500);
    let sent = 0;
    for (const { id } of ids) {
      const done = await this.database.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(subscription)
          .where(eq(subscription.id, id))
          .for("update");
        if (
          !row ||
          row.status !== "grace" ||
          !row.accountId ||
          !row.graceUntil ||
          row.graceRemindedUntil?.getTime() === row.graceUntil.getTime()
        ) {
          return false;
        }
        const lang = await this.notifications.languageOf(tx, row.accountId);
        await this.notifications.enqueue(tx, {
          kind: "payment_failed",
          template: "payment_failed",
          recipientAccountId: row.accountId,
          lang,
          variables: {},
          target: { screen: "subscription" },
          subject: { type: "subscription", id: row.id },
          dedupeKey: `subscription:${row.id}:grace-reminder:${String(row.graceUntil.getTime())}`,
        });
        await tx
          .update(subscription)
          .set({ graceRemindedUntil: row.graceUntil })
          .where(eq(subscription.id, row.id));
        return true;
      });
      if (done) sent += 1;
    }
    if (sent > 0) this.logger.log(`Grace reminders queued count=${String(sent)}`);
    return sent;
  }
}
