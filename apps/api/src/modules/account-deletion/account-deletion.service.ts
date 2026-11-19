import { createHmac } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AccountDeletedResponse,
  type AccountDeletionBlocker,
  type AccountDeletionPreview,
} from "@adclub/contracts";
import { activeOrderStatuses, deletedPhoneOf } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { anonymizeDialogsOfAccount } from "../assistant";
import { AuditLog } from "../audit";
import { SupplierMemberRemover, type RemovedMember } from "../identity";
import { FALLBACK_SUBJECT } from "../notifications";
import { OrdersService } from "../orders";
import { companyMembersLock } from "../suppliers";

const ACTIVE_ORDER_STATUSES = sql.join(
  activeOrderStatuses.map((status) => sql`${status}`),
  sql`, `,
);

/** The keys of `audit_log.before`/`after` that hold a person's name, e-mail or a part of the number. */
const PERSONAL_AUDIT_KEYS = ["name", "email", "phoneMasked", "displayName", "customerName"];

/**
 * What stands in the gateway's history in place of a deleted person's
 * number: a well-formed number nobody has (the column's check wants one).
 */
const ERASED_PHONE = "+70000000000";

/** The name of an employee whose account is deleted, in the company's history. */
const DELETED_MEMBER_NAME = "Удалённый сотрудник";

/** The subscription of a store that is still to be cancelled there (T-PRO-04). */
const LIVE_SUBSCRIPTION_STATUSES = ["active", "grace", "expired_unconfirmed", "suspended"];

interface Membership {
  memberId: string;
  supplierId: string;
  supplierName: string;
  activeMembers: number;
}

function refused(blocker: AccountDeletionBlocker): ApiException {
  if (blocker.kind === "administrator") {
    return new ApiException(
      409,
      "ACCOUNT_DELETION_REFUSED",
      "Сначала снимите права администратора",
      { details: { reason: "administrator" } },
    );
  }
  return new ApiException(
    409,
    "ACCOUNT_DELETION_REFUSED",
    `Вы единственный сотрудник «${blocker.supplierName}». Напишите в поддержку клуба, чтобы передать или закрыть кабинет`,
    {
      details: {
        reason: "last_member",
        supplierId: blocker.supplierId,
        supplierName: blocker.supplierName,
      },
    },
  );
}

/**
 * Deleting the account by the member themself (TASK-072, D-036, D-077;
 * PRODUCT 6.8; SCREENS M-PRO-05; ARCHITECTURE 4.96, 8.5 point 5).
 *
 * One transaction does all of it, so a failure leaves the account as it
 * was: the active orders are cancelled as the user's own cancellation
 * (`OrdersService.cancelAllOfAccount` — the machine, W-04 and the push to
 * the supplier as after «Отменить заявку»); the memberships go the way a
 * colleague removes an employee (`SupplierMemberRemover`, its cabinet
 * sessions with it); every other session ends (`account_deleted` —
 * `SESSION_ENDED` for any old token) and the devices leave push; the
 * account row stays (orders, reviews, complaints, discipline and the
 * journal point at it) but loses everything personal: the number becomes
 * a keyed hash written in letters (the number is free for a new account,
 * the old one is never found by it), the name, the e-mail, the city and
 * the language are cleared; the garage with its VINs and plates, the
 * mileage and the reminders are deleted; the dialogs with the assistant
 * lose their words; a club access granted by hand ends; the journal's
 * entries about the account lose the name and the e-mail. The store's
 * subscription is not cancelled — the person cancels it in the store.
 *
 * The last employee of a company and an administrator are refused before
 * anything changes (409 `ACCOUNT_DELETION_REFUSED`).
 */
@Injectable()
export class AccountDeletion {
  private readonly logger = new Logger("AccountDeletion");
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(SupplierMemberRemover) private readonly remover: SupplierMemberRemover,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = createHmac("sha256", config.session.tokenSecret)
      .update("adclub.kz deleted account phone v1")
      .digest();
  }

  /** `GET /account/deletion` — the first screen of M-PRO-05. */
  async preview(accountId: string): Promise<AccountDeletionPreview> {
    const db = this.database.db;
    const [orders, memberships, blockers, platform] = await Promise.all([
      this.activeOrders(db, accountId),
      this.memberships(db, accountId),
      this.blockers(db, accountId),
      this.subscriptionPlatform(db, accountId),
    ]);
    return {
      activeOrders: orders,
      supplierMemberships: memberships.map((member) => ({
        supplierId: member.supplierId,
        supplierName: member.supplierName,
      })),
      blockers,
      subscriptionPlatform: platform,
    };
  }

  /** `POST /account/delete` — the second step of M-PRO-05. */
  async delete(accountId: string): Promise<AccountDeletedResponse> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      // One deletion at a time, and nothing else of the account meanwhile
      // (the garage and the club access lock the same row).
      const [locked] = (
        await tx.execute<{ phone: string; status: string }>(
          sql`SELECT phone, status FROM account WHERE id = ${accountId} FOR UPDATE`,
        )
      ).rows;
      if (!locked || locked.status === "deleted") {
        throw new ApiException(404, "NOT_FOUND", "No such account");
      }
      // The companies change one at a time (TASK-017): the «last employee»
      // is counted under their locks, in a fixed order.
      const before = await this.memberships(tx, accountId);
      for (const supplierId of [...new Set(before.map((member) => member.supplierId))].sort()) {
        await tx.execute(companyMembersLock(supplierId));
      }
      const blockers = await this.blockers(tx, accountId);
      if (blockers.length > 0) {
        throw refused(blockers[0]!);
      }

      const cancelledOrders = await this.orders.cancelAllOfAccount(tx, accountId);

      const removed: RemovedMember[] = [];
      for (const member of await this.memberships(tx, accountId)) {
        const gone = await this.remover.remove(member.memberId, null, now, tx);
        if (!gone) continue;
        removed.push(gone);
        // As a colleague's removal does (TASK-017): no invitation goes out to them.
        await tx.execute(sql`
          UPDATE supplier_invitation SET status = 'cancelled', updated_at = ${now.toISOString()}::timestamptz
          WHERE member_id = ${member.memberId} AND status = 'queued'`);
        await this.audit.record(
          {
            action: auditActions.supplierMemberRemoved,
            actor: { role: "user", accountId },
            entityType: auditEntities.supplierMember,
            entityId: member.memberId,
            before: { supplierId: gone.supplierId, accountId, status: "active" },
            after: {
              status: "removed",
              sessionsEnded: gone.endedSessionIds.length,
              reason: "account_deleted",
            },
          },
          tx,
        );
      }

      // The name a company gave the person is personal too: its journal of
      // orders keeps «принял Удалённый сотрудник», not who it was.
      await tx.execute(sql`
        UPDATE supplier_member SET display_name = ${DELETED_MEMBER_NAME},
          updated_at = ${now.toISOString()}::timestamptz
        WHERE account_id = ${accountId}`);

      const sessions = await tx.execute<{ id: string }>(sql`
        UPDATE session SET revoked_at = ${now.toISOString()}::timestamptz,
          revoked_reason = 'account_deleted', updated_at = ${now.toISOString()}::timestamptz
        WHERE account_id = ${accountId} AND revoked_at IS NULL
        RETURNING id`);
      await tx.execute(sql`DELETE FROM sign_in_step WHERE account_id = ${accountId}`);
      await tx.execute(sql`DELETE FROM device_token WHERE account_id = ${accountId}`);
      await tx.execute(
        sql`DELETE FROM notification_recipient_state WHERE account_id = ${accountId}`,
      );
      await this.stopNotifications(tx, accountId, now);
      await this.forgetNumber(tx, locked.phone, now);

      const cars = await tx.execute<{ id: string }>(
        sql`DELETE FROM account_car WHERE account_id = ${accountId} RETURNING id`,
      );
      await tx.execute(sql`DELETE FROM maintenance_reminder WHERE account_id = ${accountId}`);
      await tx.execute(sql`DELETE FROM mileage_log WHERE recorded_by = ${accountId}`);
      const dialogs = await anonymizeDialogsOfAccount(tx, accountId);

      const grants = await tx.execute<{ id: string }>(sql`
        UPDATE club_access_grant SET ended_at = ${now.toISOString()}::timestamptz,
          ended_how = 'revoked', ended_by_role = 'operator', ended_by_admin_id = NULL,
          end_reason = 'Аккаунт удалён пользователем'
        WHERE account_id = ${accountId} AND ended_at IS NULL
          AND valid_until > ${now.toISOString()}::timestamptz
        RETURNING id`);

      await tx.execute(sql`
        UPDATE account SET
          phone = ${this.deletedPhone(locked.phone, accountId)},
          name = NULL, email = NULL, email_news_consent = FALSE, city_id = NULL,
          language = NULL, consent_phone_share_at = NULL, consent_version = NULL,
          status = 'deleted', deleted_at = ${now.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${accountId}`);

      await this.redactJournal(tx, accountId);
      await this.audit.record(
        {
          action: auditActions.accountDeleted,
          actor: { role: "user", accountId },
          entityType: "account",
          entityId: accountId,
          after: {
            cancelledOrders,
            carsDeleted: cars.rows.length,
            companiesLeft: removed.length,
            sessionsEnded: sessions.rows.length + removed.flatMap((r) => r.endedSessionIds).length,
            clubAccessEnded: grants.rows.length,
            assistantDialogs: dialogs,
          },
        },
        tx,
      );
      return { cancelledOrders, removed, sessions: sessions.rows.map((row) => row.id) };
    });
    for (const member of result.removed) {
      this.remover.logEnded(member);
    }
    this.logger.log(
      `Account deleted account=${accountId} orders_cancelled=${result.cancelledOrders} companies_left=${result.removed.length} sessions_ended=${result.sessions.length}`,
    );
    return { deleted: true, cancelledOrders: result.cancelledOrders };
  }

  /**
   * What stands in place of the number: a keyed hash of the number and the
   * account (the same number deleted twice never collides), in letters.
   */
  private deletedPhone(phone: string, accountId: string): string {
    return deletedPhoneOf(
      createHmac("sha256", this.key).update(`${phone}\n${accountId}`).digest("hex"),
    );
  }

  /**
   * Pushes still to go, and their WhatsApp copies (TASK-052), are not sent
   * to a deleted account; the copies already sent leave no number behind.
   */
  private async stopNotifications(tx: DbExecutor, accountId: string, now: Date): Promise<void> {
    await tx.execute(sql`
      UPDATE notification SET status = 'cancelled', updated_at = ${now.toISOString()}::timestamptz
      WHERE recipient_account_id = ${accountId} AND status = 'queued'`);
    // A push sent and not confirmed would get its WhatsApp copy from the
    // sweeper (`notifications.fallback`): decided now — the event is no
    // longer anyone's.
    await tx.execute(sql`
      UPDATE notification SET fallback_decision = 'not_current',
        fallback_decided_at = ${now.toISOString()}::timestamptz,
        updated_at = ${now.toISOString()}::timestamptz
      WHERE recipient_account_id = ${accountId} AND channel = 'push'
        AND fallback_decision IS NULL`);
    const copies = sql`(SELECT id FROM notification
      WHERE recipient_account_id = ${accountId} AND channel = 'whatsapp')`;
    await tx.execute(sql`
      UPDATE outbound_message SET status = 'cancelled', variables = NULL,
        settled_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
      WHERE subject_type = ${FALLBACK_SUBJECT} AND subject_id IN ${copies} AND status = 'queued'`);
  }

  /**
   * The number leaves the gateway's history too (TASK-072): messages to it
   * not yet sent are cancelled — as a user (the WhatsApp copies of pushes)
   * and as an employee (W-01, W-08…) — and every settled message and
   * button press keeps a placeholder instead of the number, without its
   * values. A message being sent at this very moment (`sending`, seconds)
   * keeps it: the provider already has the number.
   */
  private async forgetNumber(tx: DbExecutor, phone: string, now: Date): Promise<void> {
    const at = sql`${now.toISOString()}::timestamptz`;
    await tx.execute(sql`
      UPDATE outbound_message SET status = 'cancelled', variables = NULL, settled_at = ${at},
        updated_at = ${at}
      WHERE phone = ${phone} AND status = 'queued'`);
    await tx.execute(sql`
      UPDATE outbound_message SET phone = ${ERASED_PHONE}, variables = NULL, updated_at = ${at}
      WHERE phone = ${phone} AND status <> 'sending'`);
    await tx.execute(sql`
      UPDATE message_button_press SET from_phone = ${ERASED_PHONE} WHERE from_phone = ${phone}`);
  }

  /**
   * The entries of the action journal about the person keep what was done,
   * not who it was: the name, the e-mail and the masked number are taken out
   * of `before`/`after` of every entry about the account, its memberships
   * and what names the account (the one rewrite the journal allows, inside
   * this transaction — the migration of TASK-072).
   */
  private async redactJournal(tx: DbExecutor, accountId: string): Promise<void> {
    const memberIds = (
      await tx.execute<{ id: string }>(
        sql`SELECT id FROM supplier_member WHERE account_id = ${accountId}`,
      )
    ).rows.map((row) => row.id);
    const keys = sql`${`{${PERSONAL_AUDIT_KEYS.join(",")}}`}::text[]`;
    await tx.execute(sql`SELECT set_config('adclub.audit_redaction', 'on', true)`);
    await tx.execute(sql`
      UPDATE audit_log SET
        before = CASE WHEN jsonb_typeof(before) = 'object' THEN before - ${keys} ELSE before END,
        after = CASE WHEN jsonb_typeof(after) = 'object' THEN after - ${keys} ELSE after END
      WHERE (entity_type = 'account' AND entity_id = ${accountId})
         OR before ->> 'accountId' = ${accountId}
         OR after ->> 'accountId' = ${accountId}
         ${
           memberIds.length > 0
             ? sql`OR (entity_type = 'supplier_member' AND entity_id IN (${sql.join(
                 memberIds.map((id) => sql`${id}`),
                 sql`, `,
               )}))`
             : sql``
         }`);
    await tx.execute(sql`SELECT set_config('adclub.audit_redaction', 'off', true)`);
  }

  private async activeOrders(executor: DbExecutor, accountId: string): Promise<number> {
    const rows = await executor.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM customer_order
      WHERE user_account_id = ${accountId} AND status IN (${ACTIVE_ORDER_STATUSES})`);
    return Number(rows.rows[0]?.count ?? 0);
  }

  private async memberships(executor: DbExecutor, accountId: string): Promise<Membership[]> {
    const rows = await executor.execute<{
      member_id: string;
      supplier_id: string;
      supplier_name: string;
      active_members: number;
    }>(sql`
      SELECT member.id AS member_id, member.supplier_id, company.name AS supplier_name,
        (SELECT count(*)::int FROM supplier_member AS other
          WHERE other.supplier_id = member.supplier_id AND other.status = 'active') AS active_members
      FROM supplier_member AS member
      JOIN supplier AS company ON company.id = member.supplier_id
      WHERE member.account_id = ${accountId} AND member.status = 'active'
      ORDER BY company.name`);
    return rows.rows.map((row) => ({
      memberId: row.member_id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      activeMembers: Number(row.active_members),
    }));
  }

  private async blockers(
    executor: DbExecutor,
    accountId: string,
  ): Promise<AccountDeletionBlocker[]> {
    const blockers: AccountDeletionBlocker[] = [];
    const admin = await executor.execute<{ id: string }>(sql`
      SELECT id FROM admin_user WHERE account_id = ${accountId} AND status = 'active'`);
    if (admin.rows.length > 0) {
      blockers.push({ kind: "administrator" });
    }
    for (const member of await this.memberships(executor, accountId)) {
      if (member.activeMembers <= 1) {
        blockers.push({
          kind: "last_member",
          supplierId: member.supplierId,
          supplierName: member.supplierName,
        });
      }
    }
    return blockers;
  }

  private async subscriptionPlatform(
    executor: DbExecutor,
    accountId: string,
  ): Promise<"ios" | "android" | null> {
    const rows = await executor.execute<{ platform: "ios" | "android" | null }>(sql`
      SELECT purchase_platform AS platform FROM subscription
      WHERE account_id = ${accountId} AND audience = 'user'
        AND status IN (${sql.join(
          LIVE_SUBSCRIPTION_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})
      ORDER BY updated_at DESC LIMIT 1`);
    return rows.rows[0]?.platform ?? null;
  }
}
