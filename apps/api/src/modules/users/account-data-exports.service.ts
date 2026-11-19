import { createHmac, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  type AdminUserDataExportLink,
  type CreateAdminUserDataExportBody,
} from "@adclub/contracts";
import { isDeletedPhone } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { AccountConsents } from "../identity";
import type { AdminActor } from "./admin-users.service";
import { userNotFound } from "./admin-users.service";

/** Where the file is downloaded: outside the client contract (a file, not a page of JSON). */
export const ACCOUNT_EXPORT_DOWNLOAD_PATH = "/admin-files/account-export";

/** How long a link works: enough to start the download, too short to pass around. */
const LINK_SECONDS = 300;

function gone(): ApiException {
  return new ApiException(
    410,
    "GONE",
    "The link has expired or was used: press «Выгрузить данные…» again",
  );
}

type Row = Record<string, unknown>;

/** A timestamp of the database as ISO text, `null` kept. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * «Выгрузить данные…» (TASK-072, D-077; A-USR-02): the data the club keeps
 * about a user, on their request, by an administrator with a reason.
 *
 * Asking writes the reason to the action journal (`account.data_exported`,
 * never the content) and gives a link that works once and for minutes: the
 * token of the link names a row of `account_data_export`, the download marks
 * it used in the same statement that checks it — a second download, a
 * forged or an old token get 410, and nothing is said about why.
 *
 * The file has the profile, the consents, the garage with its VINs and
 * plates and the mileage, the orders with their items and sums, the reviews,
 * the complaints, the subscription and club access, the devices — never a
 * token, a code, a secret, another person's number or another account's
 * data. A deleted account is exported with what is left of it.
 */
@Injectable()
export class AccountDataExports {
  private readonly logger = new Logger("AdminUsers");
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AccountConsents) private readonly consents: AccountConsents,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.key = createHmac("sha256", config.session.tokenSecret)
      .update("adclub.kz account data export v1")
      .digest();
  }

  async link(
    actor: AdminActor,
    accountId: string,
    body: CreateAdminUserDataExportBody,
  ): Promise<AdminUserDataExportLink> {
    const reason = body.reason.trim();
    const expiresAt = new Date(Date.now() + LINK_SECONDS * 1000);
    const id = await this.database.db.transaction(async (tx) => {
      const found = await tx.execute(sql`SELECT id FROM account WHERE id = ${accountId}`);
      if (found.rows.length === 0) {
        throw userNotFound();
      }
      const [row] = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO account_data_export (account_id, admin_user_id, reason, expires_at)
          VALUES (${accountId}, ${actor.adminId}, ${reason}, ${expiresAt.toISOString()}::timestamptz)
          RETURNING id`)
      ).rows;
      await this.audit.record(
        {
          action: auditActions.accountDataExported,
          actor: { role: "admin", accountId: actor.accountId, adminId: actor.adminId },
          entityType: "account",
          entityId: accountId,
          after: { exportId: row!.id },
          reason,
        },
        tx,
      );
      return row!.id;
    });
    this.logger.log(`Account data export link issued account=${accountId} by=${actor.adminId}`);
    return {
      url: `${ACCOUNT_EXPORT_DOWNLOAD_PATH}?token=${encodeURIComponent(this.sign(id))}`,
      fileName: this.fileName(accountId),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The download: the link used once, or 410. */
  async take(token: string | undefined): Promise<{ fileName: string; body: string }> {
    const id = this.verify(token);
    const used = await this.database.db.execute<{ account_id: string }>(sql`
      UPDATE account_data_export SET used_at = now()
      WHERE id = ${id} AND used_at IS NULL AND expires_at > now()
        AND EXISTS (SELECT 1 FROM admin_user AS admin
          WHERE admin.id = account_data_export.admin_user_id AND admin.status = 'active')
      RETURNING account_id`);
    const accountId = used.rows[0]?.account_id;
    if (!accountId) {
      throw gone();
    }
    const data = await this.collect(this.database.db, accountId);
    this.logger.log(`Account data exported account=${accountId} export=${id}`);
    return { fileName: this.fileName(accountId), body: JSON.stringify(data, null, 2) };
  }

  /** Everything the file holds (exported for the integration test). */
  async collect(executor: DbExecutor, accountId: string): Promise<Record<string, unknown>> {
    const q = async (query: ReturnType<typeof sql>): Promise<Row[]> =>
      (await executor.execute<Row>(query)).rows;
    const [profile] = await q(sql`
      SELECT account.id, account.phone, account.name, account.email, account.email_news_consent,
        account.reminders_enabled, account.language, city.name_ru AS city, account.status,
        account.created_at, account.deleted_at
      FROM account LEFT JOIN city ON city.id = account.city_id
      WHERE account.id = ${accountId}`);
    if (!profile) {
      throw userNotFound();
    }
    const [
      consents,
      cars,
      mileage,
      orders,
      reviews,
      complaints,
      subscriptions,
      grants,
      sessions,
      devices,
    ] = await Promise.all([
      this.consents.journal(accountId, executor),
      q(sql`SELECT id, make_label, model_label, year, generation_label, body_type_label, engine_label,
            transmission_type_label, drive_type_label, color, vin, plate, document_status, document_at,
            is_primary, created_at
          FROM account_car WHERE account_id = ${accountId} ORDER BY created_at`),
      q(sql`SELECT log.car_id, log.value_km, log.source, log.recorded_at
          FROM mileage_log AS log JOIN account_car AS car ON car.id = log.car_id
          WHERE car.account_id = ${accountId} ORDER BY log.recorded_at`),
      q(sql`SELECT id, number, kind, status, quantity, unit_price, total, currency, fulfillment,
            offer_snapshot, car_snapshot, desired_at, visit_at, created_at, finished_at, closed_at
          FROM customer_order WHERE user_account_id = ${accountId} ORDER BY created_at`),
      q(sql`SELECT review.id, customer_order.number AS order_number, review.score, review.text,
            review.status, review.created_at, review.published_at
          FROM review JOIN customer_order ON customer_order.id = review.order_id
          WHERE review.user_account_id = ${accountId} ORDER BY review.created_at`),
      q(sql`SELECT complaint.id, customer_order.number AS order_number, complaint.reason,
            complaint.text, complaint.status, complaint.created_at, complaint.resolved_at
          FROM complaint JOIN customer_order ON customer_order.id = complaint.order_id
          WHERE complaint.user_account_id = ${accountId} ORDER BY complaint.created_at`),
      q(sql`SELECT id, provider, purchase_platform, status, current_period_end, grace_until,
            created_at, updated_at
          FROM subscription WHERE account_id = ${accountId} AND audience = 'user'
          ORDER BY created_at`),
      q(sql`SELECT valid_until, reason, created_at, ended_at, ended_how
          FROM club_access_grant WHERE account_id = ${accountId} ORDER BY created_at`),
      q(sql`SELECT kind, device_name, client_platform, client_version, created_at, last_used_at,
            expires_at, revoked_at, revoked_reason
          FROM session WHERE account_id = ${accountId} ORDER BY created_at`),
      q(sql`SELECT platform, device_model, registered_at, deactivated_at, deactivated_reason
          FROM device_token WHERE account_id = ${accountId} ORDER BY created_at`),
    ]);
    const phone = String(profile.phone);
    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: profile.id,
        // A deleted account has no number left — only its hash, which is not shown.
        phone: isDeletedPhone(phone) ? null : phone,
        name: profile.name,
        email: profile.email,
        emailNewsConsent: profile.email_news_consent,
        remindersEnabled: profile.reminders_enabled,
        language: profile.language,
        city: profile.city,
        status: profile.status,
        createdAt: iso(profile.created_at),
        deletedAt: iso(profile.deleted_at),
      },
      consents: consents.map((entry) => ({
        kind: entry.kind,
        version: entry.version,
        at: entry.at.toISOString(),
      })),
      garage: cars.map((car) => ({
        id: car.id,
        make: car.make_label,
        model: car.model_label,
        year: car.year,
        generation: car.generation_label,
        body: car.body_type_label,
        engine: car.engine_label,
        transmission: car.transmission_type_label,
        drive: car.drive_type_label,
        color: car.color,
        vin: car.vin,
        plate: car.plate,
        document: car.document_status
          ? { status: car.document_status, at: iso(car.document_at) }
          : null,
        primary: car.is_primary,
        addedAt: iso(car.created_at),
        mileage: mileage
          .filter((entry) => entry.car_id === car.id)
          .map((entry) => ({
            km: entry.value_km,
            source: entry.source,
            at: iso(entry.recorded_at),
          })),
      })),
      orders: orders.map((order) => {
        const snapshot = order.offer_snapshot as {
          supplier: { name: string };
          location: { cityName: string };
          item: {
            names: { ru: string | null; kk: string | null; en: string | null };
            article: string | null;
            brand: string | null;
          };
        };
        return {
          number: order.number,
          kind: order.kind,
          status: order.status,
          item: {
            name: snapshot.item.names.ru ?? snapshot.item.names.kk ?? snapshot.item.names.en,
            article: snapshot.item.article,
            brand: snapshot.item.brand,
          },
          supplier: snapshot.supplier.name,
          city: snapshot.location.cityName,
          quantity: order.quantity,
          unitPrice: order.unit_price,
          total: order.total,
          currency: order.currency,
          fulfillment: order.fulfillment,
          car: order.car_snapshot ?? null,
          desiredAt: iso(order.desired_at),
          visitAt: iso(order.visit_at),
          createdAt: iso(order.created_at),
          finishedAt: iso(order.finished_at ?? order.closed_at),
        };
      }),
      reviews: reviews.map((review) => ({
        order: review.order_number,
        score: review.score,
        text: review.text,
        status: review.status,
        createdAt: iso(review.created_at),
        publishedAt: iso(review.published_at),
      })),
      complaints: complaints.map((complaint) => ({
        order: complaint.order_number,
        reason: complaint.reason,
        text: complaint.text,
        status: complaint.status,
        createdAt: iso(complaint.created_at),
        resolvedAt: iso(complaint.resolved_at),
      })),
      subscriptions: subscriptions.map((entry) => ({
        provider: entry.provider,
        platform: entry.purchase_platform,
        status: entry.status,
        periodEnd: iso(entry.current_period_end),
        graceUntil: iso(entry.grace_until),
        createdAt: iso(entry.created_at),
      })),
      clubAccessGrants: grants.map((grant) => ({
        validUntil: iso(grant.valid_until),
        reason: grant.reason,
        grantedAt: iso(grant.created_at),
        endedAt: iso(grant.ended_at),
        ended: grant.ended_how,
      })),
      sessions: sessions.map((entry) => ({
        kind: entry.kind,
        deviceName: entry.device_name,
        platform: entry.client_platform,
        clientVersion: entry.client_version,
        createdAt: iso(entry.created_at),
        lastUsedAt: iso(entry.last_used_at),
        expiresAt: iso(entry.expires_at),
        endedAt: iso(entry.revoked_at),
        endedReason: entry.revoked_reason,
      })),
      pushDevices: devices.map((device) => ({
        platform: device.platform,
        model: device.device_model,
        registeredAt: iso(device.registered_at),
        deactivatedAt: iso(device.deactivated_at),
        deactivatedReason: device.deactivated_reason,
      })),
    };
  }

  private fileName(accountId: string): string {
    return `adclub-account-${accountId.slice(0, 8)}.json`;
  }

  private sign(id: string): string {
    const signature = createHmac("sha256", this.key).update(id).digest("base64url");
    return `${id}.${signature}`;
  }

  private verify(token: string | undefined): string {
    if (!token) throw gone();
    const [id, signature] = token.split(".");
    if (!id || !signature || !/^[0-9a-f-]{36}$/.test(id)) throw gone();
    const expected = createHmac("sha256", this.key).update(id).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw gone();
    return id;
  }
}
