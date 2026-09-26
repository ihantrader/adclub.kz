import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { notificationRecipients } from "@adclub/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import type { DbExecutor } from "../../database";
import { account, supplierMember } from "../identity";
import {
  ButtonPayloads,
  Messaging,
  MessageSubjects,
  outboundMessage,
  type MessageFacts,
  type MessageOutcome,
  type MessageSubject,
  type MessageTemplateKey,
} from "../messaging";
import { AppSettings } from "../settings";
import {
  ACCESS_CLOSED_TEXT,
  CUSTOMER_NAME_UNKNOWN,
  fulfillmentText,
  itemText,
  momentText,
  moneyText,
  orderStateText,
  phoneText,
  type NoticeLang,
} from "./order-notice-texts";
import { customerOrder, type OrderRow } from "./schema";

/**
 * The notices of orders to the supplier's employees in WhatsApp (TASK-025;
 * PRODUCT 8.4, 12.6, 15; SCREENS 8.5 W-01…W-04; ARCHITECTURE 9.1, 4.36):
 *
 * - **W-01 «Новая заявка»** — to every recipient by `notificationRecipients`
 *   (the switch on, no more than `max_notified_members`), each in their own
 *   language, with «Подтвердить» and «Отказать» whose payloads are signed
 *   for this order and this employee, and a link to the cabinet. Queued in
 *   the transaction that creates the order, and again — with the new
 *   deadline — in the transaction of an administrator's extension of it.
 * - **W-04 «Клиент отменил заявку»** — to the same recipients, when the user
 *   cancels.
 * - **W-02** — to the employee whose «Подтвердить» accepted the order: the
 *   customer's phone, which accepting is what opens (PRODUCT 10.1).
 * - **W-03** — to the employee whose press found the order moved on: what
 *   it is now («принята: Марат, 12:40», «отменена клиентом», «истекла»).
 *
 * **No notice has the confirmation code or the QR** (they are the user's,
 * 4.31 I313), and **only W-02 has the customer's phone** — the one message
 * that follows an accept. A test order of an employee is notified like any
 * other: that is what a test order is for, and it counts in no statistics
 * (4.33 I348) whatever its notices do.
 *
 * One event, one recipient, one message: every key is built from the
 * event's own row (`dedupe_key`), so a repeated job or a transaction tried
 * again writes the same message. The other recipients are **not** told that
 * a colleague has answered (ARCHITECTURE 9.1: every message is paid for, and
 * they learn it from the cabinet or from W-03 if they press).
 */

/** What every message about an order is about (`MessageSubjects`). */
export const ORDER_SUBJECT = "order";

/** The buttons of W-01 the server acts on. */
export const ORDER_BUTTONS = ["confirm", "decline"] as const;
export type OrderButton = (typeof ORDER_BUTTONS)[number];

/** An employee as a notice needs them. */
export interface NoticeMember {
  id: string;
  accountId: string;
  supplierId: string;
  displayName: string;
  phone: string;
  lang: NoticeLang;
  status: string;
  notificationsEnabledAt: Date | null;
  createdAt: Date;
}

/** The employees of one company with their numbers (active and removed). */
export async function noticeMembers(
  executor: DbExecutor,
  where: { supplierId?: string; memberIds?: readonly string[] },
  options: { share?: boolean } = {},
): Promise<NoticeMember[]> {
  const query = executor
    .select({
      id: supplierMember.id,
      accountId: supplierMember.accountId,
      supplierId: supplierMember.supplierId,
      displayName: supplierMember.displayName,
      phone: account.phone,
      lang: supplierMember.notificationLanguage,
      status: supplierMember.status,
      notificationsEnabledAt: supplierMember.notificationsEnabledAt,
      createdAt: supplierMember.createdAt,
    })
    .from(supplierMember)
    .innerJoin(account, eq(account.id, supplierMember.accountId))
    .where(
      and(
        where.supplierId ? eq(supplierMember.supplierId, where.supplierId) : undefined,
        where.memberIds ? inArray(supplierMember.id, [...where.memberIds]) : undefined,
      ),
    );
  // A press acts as the employee: their row is held until it is decided, so a
  // removal either committed first (and the press is refused) or waits.
  return options.share ? query.for("share", { of: supplierMember }) : query;
}

/** The cabinet's address (the first configured origin of the supplier web). */
function cabinetOrigin(config: AppConfig): string | null {
  return config.http.webOrigins.supplierWeb[0] ?? null;
}

@Injectable()
export class OrderNotices {
  private readonly logger = new Logger("OrderNotices");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(ButtonPayloads) private readonly payloads: ButtonPayloads,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Who of the company's employees receives the notices of orders now (PRODUCT 12.6). */
  async recipients(executor: DbExecutor, supplierId: string): Promise<NoticeMember[]> {
    const limit = await this.settings.get("max_notified_members");
    const active = (await noticeMembers(executor, { supplierId })).filter(
      (member) => member.status === "active",
    );
    const decided = notificationRecipients(active, limit);
    return active.filter((member) => decided.recipients.has(member.id));
  }

  /**
   * W-01 to every recipient — at the creation of the order (its version 1)
   * and after the administrator extends its answer deadline (the new
   * version, the new deadline): «после подтверждения уведомления
   * поставщикам отправляются повторно» (A-ORD-03).
   */
  async newOrder(tx: DbExecutor, order: OrderRow, at: Date): Promise<number> {
    const hours = await this.settings.get("order_button_valid_hours");
    const expiresAt = new Date(at.getTime() + hours * 3_600_000);
    const recipients = await this.recipients(tx, order.supplierId);
    for (const member of recipients) {
      await this.messaging.enqueue(tx, {
        template: "order_new",
        phone: member.phone,
        lang: member.lang,
        variables: {
          number: String(order.number),
          item: itemText(order.offerSnapshot.item, member.lang),
          quantity: String(order.quantity),
          total: moneyText(order.total),
          fulfillment: fulfillmentText(order.fulfillment, member.lang),
          respondBy: momentText(order.respondBy, order.offerSnapshot.location.timeZone, at),
        },
        buttons: Object.fromEntries(
          ORDER_BUTTONS.map((button) => [
            button,
            this.payloads.sign(button, [order.id, member.id], expiresAt),
          ]),
        ),
        subject: { type: ORDER_SUBJECT, id: order.id },
        dedupeKey: `order_new:${order.id}:v${String(order.version)}:${member.id}`,
      });
    }
    this.logger.log(
      `Order notices queued order=${order.id} version=${String(order.version)} recipients=${String(recipients.length)}`,
    );
    return recipients.length;
  }

  /** W-04 «Клиент отменил заявку» to the recipients. */
  async cancelled(tx: DbExecutor, order: OrderRow): Promise<number> {
    const recipients = await this.recipients(tx, order.supplierId);
    for (const member of recipients) {
      await this.messaging.enqueue(tx, {
        template: "order_cancelled_by_user",
        phone: member.phone,
        lang: member.lang,
        variables: {
          number: String(order.number),
          item: itemText(order.offerSnapshot.item, member.lang),
        },
        subject: { type: ORDER_SUBJECT, id: order.id },
        dedupeKey: `order_cancelled:${order.id}:${member.id}`,
      });
    }
    return recipients.length;
  }

  /**
   * W-02 to the employee whose «Подтвердить» accepted the order: the
   * customer's phone, opened by this very accept, and the way to the
   * cabinet. One per order — an order is accepted once.
   */
  async accepted(tx: DbExecutor, order: OrderRow, member: NoticeMember): Promise<boolean> {
    const origin = cabinetOrigin(this.config);
    if (!origin) {
      // A notice that sends the employee nowhere is no notice; the cabinet
      // has the order all the same (`SUPPLIER_WEB_ORIGINS`).
      this.logger.warn(
        `Order accepted notice not queued order=${order.id}: no cabinet address is configured (SUPPLIER_WEB_ORIGINS)`,
      );
      return false;
    }
    const [customer] = await tx
      .select({ phone: account.phone })
      .from(account)
      .where(eq(account.id, order.userAccountId));
    await this.messaging.enqueue(tx, {
      template: "order_accepted",
      phone: member.phone,
      lang: member.lang,
      variables: {
        number: String(order.number),
        customerName: CUSTOMER_NAME_UNKNOWN[member.lang],
        customerPhone: phoneText(customer?.phone ?? ""),
        link: `${origin}/orders/${order.id}`,
      },
      subject: { type: ORDER_SUBJECT, id: order.id },
      dedupeKey: `order_accepted:${order.id}`,
    });
    return true;
  }

  /**
   * W-03 «Заявка № {номер} уже {состояние}. Статус не изменён» to the
   * employee whose press changed nothing — once per order, employee and
   * intention: pressing again is not worth another paid message.
   * `accessClosed` — the employee has been removed: nothing about the order,
   * only that there is no access any more.
   */
  async stateReply(
    tx: DbExecutor,
    order: OrderRow,
    member: NoticeMember,
    intention: string,
    at: Date,
    options: { accessClosed?: boolean } = {},
  ): Promise<void> {
    let state: string;
    if (options.accessClosed) {
      state = ACCESS_CLOSED_TEXT[member.lang];
    } else {
      const [handler] = order.handledByMemberId
        ? await tx
            .select({ name: supplierMember.displayName })
            .from(supplierMember)
            .where(eq(supplierMember.id, order.handledByMemberId))
        : [];
      state = orderStateText(
        {
          status: order.status,
          handledBy: handler?.name ?? null,
          handledAt: order.handledAt,
          timeZone: order.offerSnapshot.location.timeZone,
        },
        member.lang,
        at,
      );
    }
    await this.messaging.enqueue(tx, {
      template: "order_already_handled",
      phone: member.phone,
      lang: member.lang,
      variables: { number: String(order.number), state },
      subject: { type: ORDER_SUBJECT, id: order.id },
      // The answer to a removed employee is its own kind: it says nothing of
      // the order, and it is the one W-03 that goes to someone no longer here.
      dedupeKey: `order_state:${order.id}:${member.id}:${intention}${options.accessClosed ? `:${ACCESS_CLOSED_KEY}` : ""}`,
    });
  }
}

/** The end of the key of the W-03 that tells a removed employee the access is closed. */
const ACCESS_CLOSED_KEY = "access_closed";

/** The version of the order a W-01 announced (`order_new:<order>:v<version>:<employee>`). */
function announcedVersion(dedupeKey: string): number | null {
  const match = /^order_new:[^:]+:v(\d+):/.exec(dedupeKey);
  return match ? Number(match[1]) : null;
}

/** The statuses of a W-01 that means it reached the provider (or may have). */
const WENT_OUT = ["sending", "sent", "delivered", "read", "unknown"] as const;

/**
 * What messaging asks this module about a message of an order, right
 * before sending it (`MessageSubjects`, 4.35 I359) — inside messaging's own
 * short claim, so a removal of the employee either committed first or
 * waits for it:
 *
 * - W-01 goes only while the order still waits for an answer and the
 *   employee is still one with the switch on: a notice of a new order that
 *   was accepted in the cabinet meanwhile is money for nothing;
 * - W-04 goes only to an employee who was told of the order (their W-01
 *   went out): a cancel of an order they never heard of tells them nothing;
 * - W-02 carries the customer's phone and goes only to an employee still
 *   in the company;
 * - W-01 of an older version of the order does not go: after an extension
 *   the notice with the new deadline replaces it, and two paid messages with
 *   two deadlines would only confuse (a W-01 still retrying through an outage
 *   when the administrator extends the order);
 * - W-03 goes to an employee still in the company; the one exception is the
 *   answer «доступ закрыт» to a removed one, which says nothing of the order.
 */
@Injectable()
export class OrderMessages implements MessageSubject, OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(MessageSubjects) private readonly subjects: MessageSubjects) {}

  onModuleInit(): void {
    this.subjects.register(ORDER_SUBJECT, this);
  }

  async stillSend(tx: DbExecutor, orderId: string | null, message: MessageFacts): Promise<boolean> {
    if (!orderId) {
      return false;
    }
    const template: MessageTemplateKey = message.template;
    if (
      template === "order_already_handled" &&
      message.dedupeKey.endsWith(`:${ACCESS_CLOSED_KEY}`)
    ) {
      return true;
    }
    const [order] = await tx
      .select({
        status: customerOrder.status,
        supplierId: customerOrder.supplierId,
        version: customerOrder.version,
      })
      .from(customerOrder)
      .where(eq(customerOrder.id, orderId));
    if (!order) {
      return false;
    }
    const [member] = await tx
      .select({
        status: supplierMember.status,
        notificationsEnabledAt: supplierMember.notificationsEnabledAt,
      })
      .from(supplierMember)
      .innerJoin(account, eq(account.id, supplierMember.accountId))
      .where(and(eq(supplierMember.supplierId, order.supplierId), eq(account.phone, message.phone)))
      .for("share", { of: supplierMember });
    if (member?.status !== "active") {
      return false;
    }
    switch (template) {
      case "order_new":
        return (
          order.status === "created" &&
          member.notificationsEnabledAt !== null &&
          announcedVersion(message.dedupeKey) === order.version
        );
      case "order_cancelled_by_user": {
        if (member.notificationsEnabledAt === null) {
          return false;
        }
        const [told] = await tx
          .select({ id: outboundMessage.id })
          .from(outboundMessage)
          .where(
            and(
              eq(outboundMessage.subjectType, ORDER_SUBJECT),
              eq(outboundMessage.subjectId, orderId),
              eq(outboundMessage.template, "order_new"),
              eq(outboundMessage.phone, message.phone),
              sql`${outboundMessage.status} IN (${sql.join(
                WENT_OUT.map((status) => sql`${status}`),
                sql`, `,
              )})`,
            ),
          )
          .limit(1);
        return told !== undefined;
      }
      default:
        return true;
    }
  }

  async onResult(
    _tx: DbExecutor,
    _orderId: string | null,
    _outcome: MessageOutcome,
  ): Promise<void> {
    // The message keeps its own delivery log; the order needs nothing of it
    // (the detector of an outage reads the messages themselves).
  }
}
