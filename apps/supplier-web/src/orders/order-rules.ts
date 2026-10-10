import { isApiError } from "@adclub/api-client";
import {
  orderStateConflictDetailsSchema,
  type OrderActor,
  type OrderEvent,
  type OrderStatusValue,
  type SupplierFinishedStatus,
  type SupplierOrderSummary,
} from "@adclub/contracts";
import type { Lang, SupplierTextKey } from "@adclub/i18n";
import type { OrderStatusGroup } from "@adclub/ui-core";
import { retryMinutes } from "../errors";
import type { Translate } from "../i18n";

/**
 * What the orders of the cabinet show (TASK-033, SCREENS S-ORD-01…03): the
 * pure rules of the screens — timers, groups, the buttons a status has,
 * the words of a conflict and of the journal. Nothing here decides a move
 * of an order: the server does (`orderTransition`), and a button the
 * server would refuse answers with its refusal.
 */

/** Below this the answer timer is set apart — in `warning`, with an icon (S-ORD-01). */
export const URGENT_MINUTES = 15;

const MINUTE = 60_000;

// ------------------------------------------------------------------ time

function localeOf(lang: Lang): string {
  return lang === "kk" ? "kk-KZ" : lang;
}

/** The wall clock of `iso` in `timeZone`: «2026-10-06» and «14:02». */
function wallClock(at: number, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

type Moment =
  | { day: "today" | "yesterday" | "tomorrow"; time: string }
  | { day: "date"; date: string; time: string };

/** Which day `iso` falls on, seen from `now`, in the time zone of the company's point. */
function momentOf(iso: string, timeZone: string, lang: Lang, now: number): Moment {
  const at = Date.parse(iso);
  const { date, time } = wallClock(at, timeZone);
  const dayMs = 86_400_000;
  if (date === wallClock(now, timeZone).date) return { day: "today", time };
  if (date === wallClock(now - dayMs, timeZone).date) return { day: "yesterday", time };
  if (date === wallClock(now + dayMs, timeZone).date) return { day: "tomorrow", time };
  const day = new Intl.DateTimeFormat(localeOf(lang), {
    day: "numeric",
    month: "long",
    timeZone,
  }).format(new Date(at));
  return { day: "date", date: day, time };
}

/**
 * When something happened or is due, as short as it can be said — a label
 * of its own (a line of the journal, a row of the list): «14:02» today,
 * «вчера, 14:02» / «завтра, 14:02», otherwise «6 октября, 14:02» — in the
 * time zone of the company's point.
 */
export function formatWhen(
  iso: string,
  timeZone: string,
  lang: Lang,
  t: Translate,
  now: number = Date.now(),
): string {
  const moment = momentOf(iso, timeZone, lang, now);
  switch (moment.day) {
    case "today":
      return moment.time;
    case "yesterday":
      return t("orders.when.yesterday", { time: moment.time });
    case "tomorrow":
      return t("orders.when.tomorrow", { time: moment.time });
    case "date":
      return t("orders.when.day", { day: moment.date, time: moment.time });
  }
}

/**
 * The same moment inside a sentence, with its preposition (TASK-033.A):
 * «Заявку уже принял Марат **в 14:02**» / «**вчера в 14:02**» / «**12
 * октября в 14:02**»; «at 14:02» / «yesterday at 14:02» / «on 12 October at
 * 14:02»; «14:02 кезінде» / «кеше 14:02 кезінде» / «12 қазан 14:02 кезінде».
 */
export function formatAt(
  iso: string,
  timeZone: string,
  lang: Lang,
  t: Translate,
  now: number = Date.now(),
): string {
  const moment = momentOf(iso, timeZone, lang, now);
  switch (moment.day) {
    case "today":
      return t("orders.at.today", { time: moment.time });
    case "yesterday":
      return t("orders.at.yesterday", { time: moment.time });
    case "tomorrow":
      return t("orders.at.tomorrow", { time: moment.time });
    case "date":
      return t("orders.at.day", { day: moment.date, time: moment.time });
  }
}

/** «6 октября» of a `YYYY-MM-DD` date (as the server gave it). */
export function formatDate(date: string, lang: Lang): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** The start of today in `timeZone` (Kazakhstan has no daylight saving time). */
export function startOfDay(timeZone: string, now: number = Date.now()): number {
  const { time } = wallClock(now, timeZone);
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const seconds = Math.floor(now / 1000) % 60;
  return now - (now % 1000) - seconds * 1000 - (hours * 60 + minutes) * MINUTE;
}

/** «45 мин», «2 ч», «2 ч 15 мин». */
export function durationText(minutes: number, t: Translate): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("orders.duration.minutes", { m: rest });
  if (rest === 0) return t("orders.duration.hours", { h: hours });
  return t("orders.duration.hoursMinutes", { h: hours, m: rest });
}

// ---------------------------------------------------------------- timers

export type AnswerTimer =
  | { kind: "left"; minutes: number; urgent: boolean }
  /** The deadline passed: the server expires the order on the next read. */
  | { kind: "expired" };

/**
 * «Ответить за N мин» of a new order (S-ORD-01): whole minutes, rounded
 * up, so «1 мин» is the last minute and nothing says «0 мин»; under
 * `URGENT_MINUTES` it is urgent. By the device's clock — the server's
 * answer to a press is what counts.
 */
export function answerTimer(respondBy: string, now: number): AnswerTimer {
  const left = Date.parse(respondBy) - now;
  if (left <= 0) return { kind: "expired" };
  return {
    kind: "left",
    minutes: Math.ceil(left / MINUTE),
    urgent: left < URGENT_MINUTES * MINUTE,
  };
}

/** When the timer of a list or a card should look again: the next whole minute of `respondBy`. */
export function nextTimerTick(respondBy: string, now: number): number {
  const left = Date.parse(respondBy) - now;
  if (left <= 0) return Number.POSITIVE_INFINITY;
  return left % MINUTE || MINUTE;
}

// ---------------------------------------------------------------- status

export function statusKey(status: OrderStatusValue): SupplierTextKey {
  switch (status) {
    case "created":
      return "orders.status.created";
    case "accepted":
      return "orders.status.accepted";
    case "ready":
      return "orders.status.ready";
    case "completed":
      return "orders.status.completed";
    case "cancelled_by_user":
      return "orders.status.cancelledByUser";
    case "declined_by_supplier":
      return "orders.status.declined";
    case "response_expired":
      return "orders.status.responseExpired";
    case "reserve_expired":
      return "orders.status.reserveExpired";
    case "cancelled_by_admin":
      return "orders.status.cancelledByAdmin";
  }
}

/** The colour group of a status (DESIGN 7.8). */
export function statusGroup(status: OrderStatusValue): OrderStatusGroup {
  switch (status) {
    case "created":
      return "waiting";
    case "accepted":
      return "inProgress";
    case "ready":
      return "ready";
    default:
      return "finished";
  }
}

// ---------------------------------------------------------------- groups

/** The groups of «В работе» (S-ORD-01); «Ждут ответа клиента» and services come with stage C. */
export type WorkGroup = "awaitingPickup" | "preparing" | "lateClose";

export const workGroupOrder: readonly WorkGroup[] = ["awaitingPickup", "preparing", "lateClose"];

export function workGroupOf(order: Pick<SupplierOrderSummary, "status" | "lateCloseUntil">) {
  if (order.status === "ready") return "awaitingPickup";
  if (order.status === "accepted") return "preparing";
  if (order.status === "reserve_expired" && order.lateCloseUntil) return "lateClose";
  return null;
}

/**
 * The orders of «В работе» in their groups: ready ones by the end of their
 * reserve (the nearest first), the rest as the server ordered them.
 */
export function workGroups<T extends SupplierOrderSummary>(
  orders: readonly T[],
): { group: WorkGroup; orders: T[] }[] {
  const byGroup = new Map<WorkGroup, T[]>(workGroupOrder.map((group) => [group, []]));
  for (const order of orders) {
    const group = workGroupOf(order);
    if (group) byGroup.get(group)!.push(order);
  }
  const reserveEnd = (order: T) =>
    order.reserveUntil ? Date.parse(order.reserveUntil) : Number.POSITIVE_INFINITY;
  byGroup.get("awaitingPickup")!.sort((a, b) => reserveEnd(a) - reserveEnd(b));
  byGroup
    .get("lateClose")!
    .sort((a, b) => Date.parse(a.lateCloseUntil!) - Date.parse(b.lateCloseUntil!));
  return workGroupOrder
    .map((group) => ({ group, orders: byGroup.get(group)! }))
    .filter((entry) => entry.orders.length > 0);
}

/** The orders that came since the previous answer of the list — to be lit up (S-ORD-01). */
export function arrivedIds(previous: ReadonlySet<string> | null, ids: readonly string[]): string[] {
  if (previous === null) return [];
  return ids.filter((id) => !previous.has(id));
}

// ------------------------------------------------------------- «Завершённые»

export type FinishedPeriod = "today" | "week" | "month" | "all";

export interface FinishedFilter {
  period: FinishedPeriod;
  status: SupplierFinishedStatus | null;
}

export const ALL_FINISHED: FinishedFilter = { period: "all", status: null };

/** The query of «Завершённые» for a filter: by the day the order was created. */
export function finishedQuery(
  filter: FinishedFilter,
  timeZone: string,
  now: number = Date.now(),
): { status?: SupplierFinishedStatus; from?: string } {
  const days = { today: 0, week: 6, month: 29, all: null }[filter.period];
  return {
    ...(filter.status && { status: filter.status }),
    ...(days !== null && {
      from: new Date(startOfDay(timeZone, now) - days * 86_400_000).toISOString(),
    }),
  };
}

// --------------------------------------------------------------- actions

/** The buttons of an order (the table of S-ORD-02: rows «Наличие» and «Любой»). */
export type OrderAction = "accept" | "decline" | "markReady" | "giveOut" | "closeLate";

export interface OrderActions {
  primary: OrderAction | null;
  secondary: OrderAction[];
}

const NONE: OrderActions = { primary: null, secondary: [] };

/**
 * What an employee may press on an order now — exactly what the server
 * allows from its status (stage B: items in stock only; orders of other
 * kinds get no buttons until their rows are added). A new order whose
 * answer deadline passed by this device's clock has none: the server is
 * about to expire it. A blocked company (SCREENS 6.0) keeps looking at its
 * orders and giving them out by the code, nothing else.
 */
export function orderActions(
  order: Pick<SupplierOrderSummary, "kind" | "status" | "respondBy" | "lateCloseUntil">,
  now: number,
  options: { blocked: boolean },
): OrderActions {
  if (order.kind !== "stock") return NONE;
  const { blocked } = options;
  switch (order.status) {
    case "created":
      if (blocked || answerTimer(order.respondBy, now).kind === "expired") return NONE;
      return { primary: "accept", secondary: ["decline"] };
    case "accepted":
      return blocked
        ? { primary: "giveOut", secondary: [] }
        : { primary: "markReady", secondary: ["giveOut", "decline"] };
    case "ready":
      return { primary: "giveOut", secondary: blocked ? [] : ["decline"] };
    case "reserve_expired":
      return order.lateCloseUntil && Date.parse(order.lateCloseUntil) > now
        ? { primary: "closeLate", secondary: [] }
        : NONE;
    default:
      return NONE;
  }
}

// -------------------------------------------------------------- the people

/** Who acted, as the supplier says it: an employee by name. */
export function actorName(actor: OrderActor, t: Translate): string {
  switch (actor.kind) {
    case "member":
      return actor.name;
    case "admin":
      return t("orders.actor.admin");
    case "user":
      return t("orders.actor.customer");
    case "system":
      return t("orders.actor.system");
  }
}

/** «Написать в WhatsApp»: the chat with the customer's number. */
export function whatsappLink(phone: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}`;
}

// -------------------------------------------------------------- conflicts

/**
 * The order moved while the employee looked at it (409
 * `ORDER_STATE_CONFLICT`): «Заявку уже принял {сотрудник} в {время}» — a
 * notice, not an error; the screen shows the order as it is now.
 */
export function conflictText(
  details: unknown,
  format: (iso: string) => string,
  t: Translate,
): string {
  const parsed = orderStateConflictDetailsSchema.safeParse(details);
  const last = parsed.success ? parsed.data.lastAction : undefined;
  if (!last) return t("orders.conflict.changed");
  const params = { who: actorName(last.actor, t), when: format(last.at) };
  switch (last.action) {
    case "accept":
      return t("orders.conflict.accepted", params);
    case "decline":
      return t("orders.conflict.declined", params);
    case "mark_ready":
      return t("orders.conflict.ready", params);
    case "close":
    case "close_late":
      return t("orders.conflict.givenOut", params);
    case "admin_close":
      return t("orders.conflict.adminClosed", params);
    case "admin_cancel":
      return t("orders.conflict.adminCancelled", params);
    case "cancel":
      return t("orders.conflict.cancelled", params);
    case "expire_no_response":
      return t("orders.conflict.responseExpired", params);
    case "expire_reserve":
      return t("orders.conflict.reserveExpired", params);
    default:
      return t("orders.conflict.changed");
  }
}

/** How long the buttons wait after the order changed under the employee's finger. */
export const SETTLE_MS = 1_500;

/**
 * The order changed while its card was open (a colleague, the client, a
 * deadline — seen by a re-read): the same notice a refused press would
 * give, so the employee knows why the buttons are different now; `null` —
 * nothing anyone did moved it.
 */
export function changeNotice(
  before: { status: OrderStatusValue },
  after: { status: OrderStatusValue; version: number; events: readonly OrderEvent[] },
  format: (iso: string) => string,
  t: Translate,
): string | null {
  if (before.status === after.status) return null;
  const last = [...after.events].reverse().find((event) => event.toStatus === after.status);
  return conflictText(
    {
      currentStatus: after.status,
      version: after.version,
      ...(last && { lastAction: { action: last.action, at: last.at, actor: last.actor } }),
    },
    format,
    t,
  );
}

/**
 * What a refused press says: a conflict — a notice of what happened
 * (`conflict: true`, the screen re-reads the order); anything else — an
 * error under which the order stays as it was. The company blocked while
 * the page was open (`SUPPLIER_BLOCKED`, TASK-033.A) is said in words and
 * `companyChanged`: the page re-reads the company, so the buttons the
 * server refuses go away — and come back once the block is lifted.
 */
export function actionProblem(
  error: unknown,
  format: (iso: string) => string,
  t: Translate,
): { conflict: boolean; text: string; companyChanged?: true } {
  if (!isApiError(error)) return { conflict: false, text: t("common.saveFailed") };
  switch (error.code) {
    case "ORDER_STATE_CONFLICT":
      return { conflict: true, text: conflictText(error.details, format, t) };
    case "SUPPLIER_BLOCKED":
      return { conflict: true, text: t("orders.blockedRefused"), companyChanged: true };
    case "NOT_FOUND":
      return { conflict: true, text: t("orders.notFound") };
    case "NETWORK_ERROR":
      return { conflict: false, text: t("orders.actionOffline") };
    case "RATE_LIMITED":
      return {
        conflict: false,
        text: t("common.tooManyRequests", { minutes: retryMinutes(error) }),
      };
    default:
      return { conflict: false, text: t("common.saveFailed") };
  }
}

// ---------------------------------------------------------------- journal

const declineReasonKeys = {
  out_of_stock: "orders.decline.outOfStock",
  cannot_meet_term: "orders.decline.cannotMeetTerm",
  other: "orders.decline.other",
} as const satisfies Record<string, SupplierTextKey>;

export function declineReasonKey(reason: keyof typeof declineReasonKeys): SupplierTextKey {
  return declineReasonKeys[reason];
}

/**
 * The journal of S-ORD-02 in words: «Создана 13:40 · Принял Ерлан, 14:02
 * (через WhatsApp) · Готово — Айжан, 16:10». The notes that move nothing
 * for the employee (a reserve about to end, an ignored late press) are
 * left out; who did what is the server's record.
 */
export function journalLines(
  events: readonly OrderEvent[],
  format: (iso: string) => string,
  t: Translate,
): { id: string; text: string }[] {
  const lines: { id: string; text: string }[] = [];
  for (const event of events) {
    const params = { who: actorName(event.actor, t), time: format(event.at) };
    let text: string | null;
    switch (event.action) {
      case "create":
        text = t("orders.journal.created", params);
        break;
      case "accept":
        text = t("orders.journal.accepted", params);
        break;
      case "decline":
        text = t("orders.journal.declined", params);
        if (event.details.reason) {
          text += ` · ${t(declineReasonKey(event.details.reason))}`;
        }
        break;
      case "mark_ready":
        text = t("orders.journal.ready", params);
        break;
      case "close":
        text = t(
          event.details.closeMethod === "qr"
            ? "orders.journal.givenOutQr"
            : "orders.journal.givenOutCode",
          params,
        );
        break;
      case "close_late":
        text = t("orders.journal.givenOutLate", params);
        break;
      case "admin_close":
        text = t("orders.journal.adminClosed", params);
        break;
      case "admin_cancel":
        text = t("orders.journal.adminCancelled", params);
        break;
      case "cancel":
        text = t("orders.journal.cancelled", params);
        break;
      case "expire_no_response":
        text = t("orders.journal.responseExpired", params);
        break;
      case "expire_reserve":
        text = t("orders.journal.reserveExpired", params);
        break;
      case "deadline_extended":
        text = event.details.deadline
          ? t("orders.journal.extended", { ...params, deadline: format(event.details.deadline) })
          : null;
        break;
      default:
        text = null;
    }
    if (text === null) continue;
    if (event.channel === "whatsapp") text += ` ${t("orders.journal.viaWhatsapp")}`;
    lines.push({ id: event.id, text });
  }
  return lines;
}
