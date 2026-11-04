import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { NotificationKind, OfferSnapshot } from "@adclub/contracts";
import { isActiveOrderStatus, localDateTime, type OrderAction } from "@adclub/domain";
import type { DbExecutor } from "../../database";
import { ClubAccess } from "../club-access";
import {
  Notifications,
  NotificationSubjects,
  SUPPLIER_WORD,
  type EnqueueNotificationInput,
  type PushLang,
} from "../notifications";
import { supplierNameForUser } from "./order-views";
import { customerOrder, type OrderRow } from "./schema";
import { eq } from "drizzle-orm";

/**
 * The pushes of an order to its user (TASK-051; PRODUCT 15; SCREENS 8.4;
 * ARCHITECTURE 6.1–6.3, 4.79) — queued by `OrderTransitions` in the
 * transaction of the move itself, so a move that is rolled back or lost to a
 * race sends nothing, and the key `order:<id>:<action>:v<version>` makes one
 * move one push whatever the queue does.
 *
 * Which moves push (and which don't) is `pushOfMove` — a pure function, the
 * table of the report. The user's own moves (a cancel, «Согласиться») send
 * nothing; the moves SCREENS 8.4 has no text for (the end of a reserve, the
 * end of the time to answer, an administrator's cancel, a no-show, an
 * unresolved visit) send nothing either until the Product Owner approves a
 * text (TASK-051 report).
 *
 * The push carries only what its text of SCREENS 8.4 says: the item, the
 * supplier's name (or «Поставщик»), dates and times — never the code, the QR,
 * a telephone, an address or an employee's name.
 */

type OrderPushKind = Pick<EnqueueNotificationInput, "kind" | "template">;

/** What a move of an order pushes to its user; `null` — nothing. */
export function pushOfMove(
  action: OrderAction,
  order: Pick<OrderRow, "kind" | "fulfillment" | "expiresAt">,
): OrderPushKind | null {
  switch (action) {
    case "accept":
      // «Подтвердить срок» of an order under order is P-ORD-08, «Подтвердить
      // время» of a service is P-ORD-09; an item in stock — P-ORD-01.
      if (order.kind === "on_order") return { kind: "order_confirmed", template: "term_confirmed" };
      if (order.kind === "service") return { kind: "order_confirmed", template: "time_confirmed" };
      return { kind: "order_accepted", template: "order_accepted" };
    case "mark_ready":
      return order.fulfillment === "pickup" && order.expiresAt
        ? { kind: "order_ready", template: "order_ready" }
        : { kind: "order_ready", template: "order_ready_delivery" };
    case "decline":
      return { kind: "order_declined", template: "order_declined" };
    case "propose_term":
      return { kind: "term_proposed", template: "term_proposed" };
    case "propose_time":
      return { kind: "time_proposed", template: "time_proposed" };
    case "close":
    case "close_late":
    case "admin_close":
      // PRODUCT 10.7: a late close and the administrator's close are the
      // ordinary notice of a closed order.
      return { kind: "order_closed", template: "order_closed" };
    case "expire_no_response":
      return { kind: "order_expired_no_response", template: "order_expired_no_response" };
    default:
      return null;
  }
}

const ITEM_MAX_LENGTH = 120;

const MONTHS: Readonly<Record<PushLang, readonly string[]>> = {
  ru: [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ],
  kk: [
    "қаңтар",
    "ақпан",
    "наурыз",
    "сәуір",
    "мамыр",
    "маусым",
    "шілде",
    "тамыз",
    "қыркүйек",
    "қазан",
    "қараша",
    "желтоқсан",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};

function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The item as the snapshot keeps it, in the person's language, with its article. */
export function pushItemText(item: OfferSnapshot["item"], lang: PushLang): string {
  const name = oneLine(item.names[lang] ?? item.names.ru ?? item.names.kk ?? item.names.en ?? "");
  const article = item.article ? oneLine(item.article) : "";
  const text = article && !name.includes(article) ? `${name} ${article}`.trim() : name;
  const chars = [...(text || article || "—")];
  return chars.length <= ITEM_MAX_LENGTH
    ? chars.join("")
    : `${chars
        .slice(0, ITEM_MAX_LENGTH - 1)
        .join("")
        .trimEnd()}…`;
}

/** «14 октября», «14 қазан», «14 October». */
export function pushDateText(isoDate: string, lang: PushLang): string {
  const [, month = 1, day = 1] = isoDate.split("-").map(Number);
  return `${String(day)} ${MONTHS[lang][month - 1] ?? ""}`.trim();
}

/** «18:30» in the point's time zone. */
export function pushTimeText(at: Date, timeZone: string): string {
  const local = localDateTime(at, timeZone);
  const hours = String(Math.floor(local.minutes / 60)).padStart(2, "0");
  const minutes = String(local.minutes % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** «18:30, 14 октября» — a moment with its day, in the point's time zone. */
export function pushMomentText(at: Date, timeZone: string, lang: PushLang): string {
  const local = localDateTime(at, timeZone);
  return `${pushTimeText(at, timeZone)}, ${pushDateText(local.date, lang)}`;
}

/** The values of a template for this order, in the person's language. */
export function orderPushVariables(
  template: EnqueueNotificationInput["template"],
  order: OrderRow,
  lang: PushLang,
  supplierName: string | null,
): Record<string, string> {
  const timeZone = order.offerSnapshot.location.timeZone;
  const item = pushItemText(order.offerSnapshot.item, lang);
  const supplier = supplierName ? oneLine(supplierName) : SUPPLIER_WORD[lang];
  switch (template) {
    case "order_accepted":
      return { supplier, item };
    case "order_ready":
      return {
        item,
        until: order.expiresAt ? pushMomentText(order.expiresAt, timeZone, lang) : "—",
      };
    case "order_ready_delivery":
    case "order_declined":
    case "order_closed":
    case "supply_overdue":
      return { item };
    case "reserve_expiring":
      return { item, time: order.expiresAt ? pushTimeText(order.expiresAt, timeZone) : "—" };
    case "term_proposed":
      return {
        date: order.proposedReadyOn ? pushDateText(order.proposedReadyOn, lang) : "—",
        answerBy: order.termAnswerBy ? pushMomentText(order.termAnswerBy, timeZone, lang) : "—",
      };
    case "time_proposed": {
      const at = order.proposedAt;
      return {
        date: at ? pushDateText(localDateTime(at, timeZone).date, lang) : "—",
        time: at ? pushTimeText(at, timeZone) : "—",
        answerBy: order.termAnswerBy ? pushMomentText(order.termAnswerBy, timeZone, lang) : "—",
      };
    }
    case "term_confirmed":
      return { date: order.receiptOn ? pushDateText(order.receiptOn, lang) : "—" };
    case "time_confirmed": {
      const at = order.visitAt;
      return {
        date: at ? pushDateText(localDateTime(at, timeZone).date, lang) : "—",
        time: at ? pushTimeText(at, timeZone) : "—",
        supplier,
      };
    }
    case "order_expired_no_response":
      return {};
    default:
      throw new Error(`The push template ${template} is not one of an order`);
  }
}

/**
 * Whether a push about an order still says something true (TASK-052,
 * ARCHITECTURE 4.80 I871): its WhatsApp copy is not sent for an order that
 * moved on without a push of its own — cancelled by the user or an
 * administrator, expired, a reserve whose time has passed, a proposal the
 * user can no longer answer. The final events (declined, closed, not answered,
 * the review) are true for good.
 */
export function orderPushCurrent(
  order: Pick<OrderRow, "status" | "expiresAt" | "termAnswerBy">,
  kind: NotificationKind,
  now: Date,
): boolean {
  switch (kind) {
    case "order_declined":
    case "order_closed":
    case "order_expired_no_response":
    case "review_text_rejected":
      return true;
    case "term_proposed":
    case "time_proposed":
      return (
        order.status === "term_proposed" &&
        order.termAnswerBy !== null &&
        order.termAnswerBy.getTime() > now.getTime()
      );
    case "reserve_expiring":
      return (
        isActiveOrderStatus(order.status) &&
        order.expiresAt !== null &&
        order.expiresAt.getTime() > now.getTime()
      );
    default:
      return isActiveOrderStatus(order.status);
  }
}

@Injectable()
export class OrderPushes implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Notifications) private readonly notifications: Notifications,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
    @Inject(NotificationSubjects) private readonly subjects: NotificationSubjects,
  ) {}

  onModuleInit(): void {
    this.subjects.register("order", async (tx, orderId, kind) => {
      const [order] = await tx
        .select({
          status: customerOrder.status,
          expiresAt: customerOrder.expiresAt,
          termAnswerBy: customerOrder.termAnswerBy,
        })
        .from(customerOrder)
        .where(eq(customerOrder.id, orderId));
      return order ? orderPushCurrent(order, kind, new Date()) : false;
    });
  }

  /** After a move of `OrderTransitions.apply`, in its transaction. */
  async afterMove(tx: DbExecutor, order: OrderRow, action: OrderAction): Promise<void> {
    const push = pushOfMove(action, order);
    if (push) {
      await this.send(tx, order, push, `order:${order.id}:${action}:v${String(order.version)}`);
    }
  }

  /** The sweeper's warning that the reserve ends soon (P-ORD-03): once per reserve. */
  async reserveExpiring(tx: DbExecutor, order: OrderRow): Promise<void> {
    await this.send(
      tx,
      order,
      { kind: "reserve_expiring", template: "reserve_expiring" },
      `order:${order.id}:reserve_expiring:${order.expiresAt?.toISOString() ?? "none"}`,
    );
  }

  /** The confirmed date of an order under order passed (ARCHITECTURE 4.59): once per order. */
  async supplyOverdue(tx: DbExecutor, order: OrderRow): Promise<void> {
    await this.send(
      tx,
      order,
      { kind: "supply_overdue", template: "supply_overdue" },
      `order:${order.id}:supply_overdue`,
    );
  }

  private async send(
    tx: DbExecutor,
    order: OrderRow,
    push: OrderPushKind,
    dedupeKey: string,
  ): Promise<void> {
    const lang = await this.notifications.languageOf(tx, order.userAccountId);
    // SCREENS 8.4: without club access at the moment of sending, «Поставщик».
    const access = await this.clubAccess.has(order.userAccountId, tx);
    const supplierName = await supplierNameForUser(tx, order, access);
    await this.notifications.enqueue(tx, {
      ...push,
      recipientAccountId: order.userAccountId,
      lang,
      variables: orderPushVariables(push.template, order, lang, supplierName),
      // TASK-052: the WhatsApp copy of a critical push has no English template —
      // a person reading English gets the Russian one, with Russian values.
      ...(lang === "en"
        ? { fallbackVariables: orderPushVariables(push.template, order, "ru", supplierName) }
        : {}),
      target: { screen: "order", params: { orderId: order.id } },
      subject: { type: "order", id: order.id },
      dedupeKey,
    });
  }
}
