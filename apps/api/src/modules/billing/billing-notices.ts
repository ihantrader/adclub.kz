import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { bankRetriesLeft, BILLING_TIME_ZONE, nextDailyRun } from "@adclub/domain";
import { APP_CONFIG, type AppConfig } from "../../config";
import type { DbExecutor } from "../../database";
import { account, supplierMember } from "../identity";
import { Messaging } from "../messaging";
import { AppSettings } from "../settings";

/** What a message about a subscription is about (`MessageSubjects`). */
export const SUBSCRIPTION_SUBJECT = "subscription";

type NoticeLang = "kk" | "ru";

export interface BillingRecipient {
  memberId: string;
  phone: string;
  lang: NoticeLang;
}

/** How many employees hear of a payment when nobody is the contact person and nobody takes notices. */
const FALLBACK_RECIPIENTS = 3;

const LOCALES: Record<NoticeLang, string> = { ru: "ru-RU", kk: "kk-KZ" };

/** «5 ноября» / «5 қараша» — the day in the club's time zone. */
export function dayText(at: Date, lang: NoticeLang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    day: "numeric",
    month: "long",
    timeZone: BILLING_TIME_ZONE,
  }).format(at);
}

/** The calendar day of a moment in the club's time zone (`YYYY-MM-DD`): «one message a day». */
export function localDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: BILLING_TIME_ZONE,
  }).format(at);
}

/**
 * W-05, the notice of an unpaid subscription (PRODUCT 14.3; SCREENS 8.5;
 * ARCHITECTURE 18.5, 4.77): «Не удалось списать оплату подписки. Повторим
 * {дата}. Обновите карту: {ссылка}». The only way a message about money is
 * queued — in the transaction of the refusal that causes it, through
 * `Messaging.enqueue`, one per recipient per day.
 *
 * **Who hears of it: the company's contact person** (the one a person of the
 * club would call about money); if the contact person was removed, the
 * employees who receive the notices of orders; if there are none either,
 * the first employees of the company. Never nobody: a payment nobody hears
 * of ends in a pause nobody understands.
 */
@Injectable()
export class BillingNotices {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The settings a notice needs, read **before** a transaction opens: a
   * query on another connection made while a transaction holds rows would
   * wait for it, and a transaction that waits for its own pool is a
   * deadlock the database cannot see.
   */
  async tuning(): Promise<{ retryDays: number; hour: number; notifiedLimit: number }> {
    const [retryDays, hour, notifiedLimit] = await Promise.all([
      this.settings.get("billing_retry_days"),
      this.settings.get("billing_notify_hour"),
      this.settings.get("max_notified_members"),
    ]);
    return { retryDays, hour, notifiedLimit };
  }

  async recipients(
    executor: DbExecutor,
    supplierId: string,
    notifiedLimit: number,
  ): Promise<BillingRecipient[]> {
    const rows = await executor
      .select({
        memberId: supplierMember.id,
        phone: account.phone,
        lang: supplierMember.notificationLanguage,
        contact: supplierMember.isContactPerson,
        enabledAt: supplierMember.notificationsEnabledAt,
      })
      .from(supplierMember)
      .innerJoin(account, eq(account.id, supplierMember.accountId))
      .where(and(eq(supplierMember.supplierId, supplierId), eq(supplierMember.status, "active")))
      .orderBy(asc(supplierMember.createdAt), asc(supplierMember.id));
    const contacts = rows.filter((row) => row.contact);
    let chosen = contacts;
    if (chosen.length === 0) {
      chosen = rows
        .filter((row) => row.enabledAt !== null)
        .sort((a, b) => a.enabledAt!.getTime() - b.enabledAt!.getTime())
        .slice(0, notifiedLimit);
    }
    if (chosen.length === 0) {
      chosen = rows.slice(0, FALLBACK_RECIPIENTS);
    }
    return chosen.map((row) => ({ memberId: row.memberId, phone: row.phone, lang: row.lang }));
  }

  /**
   * W-05 after a refusal of the bank. «Повторим {дата}» is the next
   * attempt of the daily job; when the retries are over there is none, and
   * the date is the one the offers leave the showcase — the template says
   * «Повторим», its text can't change without Meta approving it again, and
   * the date is still the one the payer has to act by.
   */
  async paymentFailed(
    tx: DbExecutor,
    input: {
      subscriptionId: string;
      supplierId: string;
      declinedCount: number;
      at: Date;
      graceUntil: Date;
      /** From `tuning()`, read before the transaction. */
      retryDays: number;
      hour: number;
      notifiedLimit: number;
    },
  ): Promise<number> {
    const origin = this.config.http.webOrigins.supplierWeb[0];
    if (!origin) {
      this.logger.warn(`No cabinet address to put into W-05 supplier=${input.supplierId}`);
      return 0;
    }
    const next = bankRetriesLeft(input.declinedCount, input.retryDays)
      ? nextDailyRun(input.at, input.hour)
      : input.graceUntil;
    const recipients = await this.recipients(tx, input.supplierId, input.notifiedLimit);
    const day = localDay(input.at);
    for (const recipient of recipients) {
      await this.messaging.enqueue(tx, {
        template: "payment_failed",
        phone: recipient.phone,
        lang: recipient.lang,
        variables: { date: dayText(next, recipient.lang), link: `${origin}/billing` },
        subject: { type: SUBSCRIPTION_SUBJECT, id: input.subscriptionId },
        dedupeKey: `payment_failed:${input.subscriptionId}:${day}:${recipient.memberId}`,
      });
    }
    return recipients.length;
  }
}
