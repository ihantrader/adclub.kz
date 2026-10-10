import { isApiError } from "@adclub/api-client";
import {
  orderStateConflictDetailsSchema,
  type OrderActor,
  type OrderEvent,
  type OrderKind,
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

/** «пн, 13 окт.» — a date of the term to choose (S-ORD-04), as the server gave it. */
export function formatTermDay(date: string, lang: Lang): string {
  return new Intl.DateTimeFormat(localeOf(lang), {
    weekday: "short",
    day: "numeric",
    month: "short",
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

/**
 * The word of a status; `kind` (TASK-037) — «Принята» of an order under
 * order is «Срок подтверждён» (S-ORD-02), of a service — «Подтверждена»
 * (TASK-038).
 */
export function statusKey(status: OrderStatusValue, kind?: OrderKind): SupplierTextKey {
  switch (status) {
    case "created":
      return "orders.status.created";
    case "accepted":
      return kind === "on_order"
        ? "orders.status.termConfirmed"
        : kind === "service"
          ? "orders.status.timeConfirmed"
          : "orders.status.accepted";
    case "term_proposed":
      return "orders.status.termProposed";
    case "term_expired":
      return kind === "service" ? "orders.status.timeExpired" : "orders.status.termExpired";
    // TASK-038: a service.
    case "no_show":
      return "orders.status.noShow";
    case "visit_unresolved":
      return "orders.status.visitUnresolved";
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
    case "term_proposed":
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

/**
 * The groups of «В работе» (S-ORD-01); «Ждут ответа клиента» — orders under
 * order whose other term, or services whose other time, waits for the
 * customer (TASK-037, TASK-038); «Записи на услуги» — confirmed visits, by
 * their time (TASK-038).
 */
export type WorkGroup =
  "awaitingPickup" | "preparing" | "awaitingCustomer" | "services" | "lateClose";

export const workGroupOrder: readonly WorkGroup[] = [
  "awaitingPickup",
  "preparing",
  "awaitingCustomer",
  "services",
  "lateClose",
];

export function workGroupOf(
  order: Pick<SupplierOrderSummary, "status" | "lateCloseUntil"> &
    Partial<Pick<SupplierOrderSummary, "kind">>,
): WorkGroup | null {
  if (order.status === "ready") return "awaitingPickup";
  if (order.status === "accepted") return order.kind === "service" ? "services" : "preparing";
  if (order.status === "term_proposed") return "awaitingCustomer";
  if (
    (order.status === "reserve_expired" || order.status === "visit_unresolved") &&
    order.lateCloseUntil
  ) {
    return "lateClose";
  }
  return null;
}

/** The time of a confirmed visit (TASK-038); none — the end of time. */
function visitTime(order: SupplierOrderSummary): number {
  const at = order.serviceVisit?.confirmed?.visitAt;
  return at ? Date.parse(at) : Number.POSITIVE_INFINITY;
}

/**
 * The orders of «В работе» in their groups: ready ones by the end of their
 * reserve (the nearest first), visits by their time, the rest as the server
 * ordered them.
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
  byGroup.get("services")!.sort((a, b) => visitTime(a) - visitTime(b));
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

/** The buttons of an order (the table of S-ORD-02: rows «Наличие», «Под заказ» and «Любой»). */
export type OrderAction =
  | "accept"
  | "decline"
  | "markReady"
  | "giveOut"
  | "closeLate"
  /** S-ORD-04 «Предложить другой срок» of a new order under order (TASK-039). */
  | "proposeTerm";

export interface OrderActions {
  primary: OrderAction | null;
  secondary: OrderAction[];
}

const NONE: OrderActions = { primary: null, secondary: [] };

/**
 * What an employee may press on an order now — exactly what the server
 * allows from its status. An order under order (TASK-037, TASK-039): a new
 * one — «Подтвердить срок до {дата}» · «Предложить другой срок» · «Отказать»;
 * a confirmed term — the buttons of «Принята»; while the customer decides —
 * only «Отказать» (D-072). A service (TASK-038) — until the screens of
 * TASK-039.B, the buttons it shares with goods: a new one — «Подтвердить
 * время» · «Отказать»; a confirmed one — «Отметить выполнение по QR / коду»
 * · «Отказать»; while the customer decides — «Отказать»; an unresolved one
 * inside its window — «Закрыть по коду». A kind this version does not know
 * gets no buttons. A new order whose answer deadline passed by this
 * device's clock has none: the server is about to expire it. A blocked
 * company (SCREENS 6.0) keeps looking at its orders and giving them out by
 * the code, nothing else.
 */
export function orderActions(
  order: Pick<SupplierOrderSummary, "kind" | "status" | "respondBy" | "lateCloseUntil">,
  now: number,
  options: { blocked: boolean },
): OrderActions {
  if (order.kind !== "stock" && order.kind !== "on_order" && order.kind !== "service") {
    return NONE;
  }
  const { blocked } = options;
  if (order.kind === "service" && order.status === "accepted") {
    return { primary: "giveOut", secondary: blocked ? [] : ["decline"] };
  }
  switch (order.status) {
    case "created":
      if (blocked || answerTimer(order.respondBy, now).kind === "expired") return NONE;
      return order.kind === "on_order"
        ? { primary: "accept", secondary: ["proposeTerm", "decline"] }
        : { primary: "accept", secondary: ["decline"] };
    case "term_proposed":
      // D-072: the goods won't come — no need to wait for the customer.
      return blocked ? NONE : { primary: null, secondary: ["decline"] };
    case "accepted":
      return blocked
        ? { primary: "giveOut", secondary: [] }
        : { primary: "markReady", secondary: ["giveOut", "decline"] };
    case "ready":
      return { primary: "giveOut", secondary: blocked ? [] : ["decline"] };
    case "reserve_expired":
    case "visit_unresolved":
      return order.lateCloseUntil && Date.parse(order.lateCloseUntil) > now
        ? { primary: "closeLate", secondary: [] }
        : NONE;
    default:
      return NONE;
  }
}

/**
 * «Срок» of an order under order in the card (S-ORD-02, TASK-037): the
 * confirmed term once there is one; another term and until when the
 * customer answers while they decide; otherwise the term the customer agreed
 * to by ordering. `note` — the supply is overdue. `null` — an order in stock.
 */
export function termWords(
  order: Pick<SupplierOrderSummary, "status" | "onOrderTerm">,
  formatDay: (date: string) => string,
  format: (iso: string) => string,
  t: Translate,
): { text: string; note: string | null } | null {
  const term = order.onOrderTerm;
  if (!term) return null;
  const day = (date: string | null) => (date ? formatDay(date) : "—");
  const note = term.overdueSince ? t("orders.term.overdue") : null;
  if (term.confirmed) {
    return {
      text: t("orders.term.confirmed", {
        days: term.confirmed.leadDays,
        date: day(term.confirmed.readyOn),
      }),
      note,
    };
  }
  if (term.proposed && order.status === "term_proposed") {
    return {
      text: t("orders.term.proposed", {
        days: term.proposed.leadDays,
        date: day(term.proposed.readyOn),
        time: format(term.proposed.answerBy),
      }),
      note,
    };
  }
  return {
    text: t("orders.term.expected", {
      days: term.expected.leadDays,
      date: day(term.expected.readyOn),
    }),
    note,
  };
}

/**
 * The car and the time of an order on a service (S-ORD-02 «модель
 * автомобиля, желаемые дата и время», TASK-038): the confirmed time once
 * there is one; another time and until when the customer answers while
 * they decide; otherwise the time the customer asked for. `null` — goods.
 */
export function visitWords(
  order: Pick<SupplierOrderSummary, "status" | "serviceVisit">,
  format: (iso: string) => string,
  t: Translate,
): { car: string; time: string } | null {
  const visit = order.serviceVisit;
  if (!visit) return null;
  const car = [visit.car.make.label, visit.car.model.label, visit.car.year ?? ""].join(" ").trim();
  if (visit.confirmed) {
    return { car, time: t("orders.visit.confirmed", { time: format(visit.confirmed.visitAt) }) };
  }
  if (visit.proposed && order.status === "term_proposed") {
    return {
      car,
      time: t("orders.visit.proposed", {
        time: format(visit.proposed.visitAt),
        answer: format(visit.proposed.answerBy),
      }),
    };
  }
  return { car, time: t("orders.visit.desired", { time: format(visit.desiredAt) }) };
}

/**
 * «Срок поставки прошёл» — the mark of the list and the card (S-ORD-01,
 * TASK-039): the server said the confirmed date passed (`overdueSince`)
 * and the order is still not ready; once ready or over, nothing to mark.
 */
export function supplyOverdue(
  order: Pick<SupplierOrderSummary, "status" | "onOrderTerm">,
): boolean {
  return order.status === "accepted" && Boolean(order.onOrderTerm?.overdueSince);
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
  /** The order's kind: a service talks of a time (TASK-038). */
  kind?: OrderKind,
): string {
  const parsed = orderStateConflictDetailsSchema.safeParse(details);
  const last = parsed.success ? parsed.data.lastAction : undefined;
  if (!last) return t("orders.conflict.changed");
  const params = { who: actorName(last.actor, t), when: format(last.at) };
  const service = kind === "service";
  switch (last.action) {
    case "accept":
      return t(service ? "orders.conflict.timeConfirmed" : "orders.conflict.accepted", params);
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
    // TASK-037: an order under order.
    case "propose_term":
      return t("orders.conflict.termProposed", params);
    case "agree_term":
      return t(service ? "orders.conflict.timeAgreed" : "orders.conflict.termAgreed", params);
    case "reject_term":
      return t(service ? "orders.conflict.timeRejected" : "orders.conflict.termRejected", params);
    case "expire_term":
      return t(service ? "orders.conflict.timeExpired" : "orders.conflict.termExpired", params);
    // TASK-038: a service.
    case "propose_time":
      return t("orders.conflict.timeProposed", params);
    case "mark_no_show":
      return t("orders.conflict.noShow", params);
    case "expire_visit":
      return t("orders.conflict.visitUnresolved", params);
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
  after: {
    status: OrderStatusValue;
    version: number;
    events: readonly OrderEvent[];
    kind?: OrderKind;
  },
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
    after.kind,
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
  /** The order's kind (TASK-038: a service talks of a time). */
  kind?: OrderKind,
): { conflict: boolean; text: string; companyChanged?: true } {
  if (!isApiError(error)) return { conflict: false, text: t("common.saveFailed") };
  switch (error.code) {
    case "ORDER_STATE_CONFLICT":
      return { conflict: true, text: conflictText(error.details, format, t, kind) };
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

/**
 * What a refused «Отправить клиенту» says (S-ORD-04, TASK-039): the date is
 * no longer one to propose (a day has turned, the hours changed) — at the
 * dates, which are loaded again (`stale: true`); anything else — as any
 * refused press (a colleague or the button of WhatsApp was first).
 */
export function proposeProblem(
  error: unknown,
  format: (iso: string) => string,
  t: Translate,
): { conflict: boolean; text: string; stale?: true; companyChanged?: true } {
  if (isApiError(error) && error.code === "VALIDATION_ERROR") {
    return { conflict: false, text: t("orders.termDialog.dateRefused"), stale: true };
  }
  return actionProblem(error, format, t);
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
  /** A calendar date of the term in words («12 октября»); TASK-037. */
  formatDay: (date: string) => string = (date) => date,
  /** TASK-039: «Принял» of an order under order reads «Подтвердил срок». */
  kind?: OrderKind,
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
        text = t(
          kind === "on_order"
            ? "orders.journal.termConfirmed"
            : kind === "service"
              ? "orders.journal.timeConfirmed"
              : "orders.journal.accepted",
          params,
        );
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
      // TASK-037: the term of an order under order.
      case "propose_term":
        text = t("orders.journal.termProposed", {
          ...params,
          days: event.details.leadDays ?? 0,
          date: event.details.readyOn ? formatDay(event.details.readyOn) : "",
        });
        break;
      case "agree_term":
        text = t(
          kind === "service" ? "orders.journal.timeAgreed" : "orders.journal.termAgreed",
          params,
        );
        break;
      case "reject_term":
        text = t(
          kind === "service" ? "orders.journal.timeRejected" : "orders.journal.termRejected",
          params,
        );
        break;
      case "expire_term":
        text = t(
          kind === "service" ? "orders.journal.timeExpired" : "orders.journal.termExpired",
          params,
        );
        break;
      // TASK-038: a service.
      case "propose_time":
        text = t("orders.journal.timeProposed", {
          ...params,
          visit: event.details.visitAt ? format(event.details.visitAt) : "",
        });
        break;
      case "mark_no_show":
        text = t("orders.journal.noShow", params);
        break;
      case "expire_visit":
        text = t("orders.journal.visitUnresolved", params);
        break;
      case "late_cancel":
        text = t("orders.journal.lateCancel", params);
        break;
      case "supply_overdue":
        text = t("orders.journal.supplyOverdue", params);
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
