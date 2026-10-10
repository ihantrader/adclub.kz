import { ApiError } from "@adclub/api-client";
import type { OrderEvent, SupplierOrderSummary } from "@adclub/contracts";
import { supplierText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import type { Translate } from "../i18n";
import {
  actionProblem,
  answerTimer,
  arrivedIds,
  changeNotice,
  conflictText,
  durationText,
  finishedQuery,
  formatAt,
  formatDate,
  formatWhen,
  journalLines,
  nextTimerTick,
  orderActions,
  formatTermDay,
  proposeProblem,
  supplyOverdue,
  startOfDay,
  statusKey,
  termWords,
  whatsappLink,
  workGroupOf,
  workGroups,
  visitWords,
} from "./order-rules";

const t: Translate = (key, params) => supplierText("ru", key, params);
const ALMATY = "Asia/Almaty";
const MINUTE = 60_000;
/** 2026-10-06 12:00 in Almaty (UTC+5). */
const NOON = Date.parse("2026-10-06T07:00:00Z");

function summary(overrides: Partial<SupplierOrderSummary>): SupplierOrderSummary {
  return {
    id: crypto.randomUUID(),
    number: 1001,
    kind: "stock",
    status: "created",
    isTest: false,
    quantity: 1,
    unitPrice: 12_500,
    total: 12_500,
    currency: "KZT",
    fulfillment: "pickup",
    item: {
      id: crypto.randomUUID(),
      type: "part",
      name: { text: "Колодки", isFallback: false },
      article: null,
      brand: null,
    },
    respondBy: new Date(NOON + 60 * MINUTE).toISOString(),
    reserveUntil: null,
    receiptOn: null,
    onOrderTerm: null,
    serviceVisit: null,
    createdAt: new Date(NOON - 10 * MINUTE).toISOString(),
    offerId: crypto.randomUUID(),
    handledBy: null,
    handledAt: null,
    closure: null,
    version: 1,
    lateCloseUntil: null,
    ...overrides,
  };
}

describe("the answer timer (S-ORD-01)", () => {
  it("counts whole minutes up, never «0 мин», and is urgent under 15 minutes", () => {
    const due = (ms: number) => new Date(NOON + ms).toISOString();
    expect(answerTimer(due(90 * MINUTE), NOON)).toEqual({
      kind: "left",
      minutes: 90,
      urgent: false,
    });
    expect(answerTimer(due(15 * MINUTE), NOON)).toEqual({
      kind: "left",
      minutes: 15,
      urgent: false,
    });
    expect(answerTimer(due(15 * MINUTE - 1), NOON)).toEqual({
      kind: "left",
      minutes: 15,
      urgent: true,
    });
    expect(answerTimer(due(1_000), NOON)).toEqual({ kind: "left", minutes: 1, urgent: true });
    expect(answerTimer(due(0), NOON)).toEqual({ kind: "expired" });
    expect(answerTimer(due(-MINUTE), NOON)).toEqual({ kind: "expired" });
  });

  it("says minutes and hours as a person would", () => {
    expect(durationText(45, t)).toBe("45 мин");
    expect(durationText(120, t)).toBe("2 ч");
    expect(durationText(135, t)).toBe("2 ч 15 мин");
  });

  it("knows when the shown minute changes next", () => {
    const due = new Date(NOON + 10 * MINUTE + 20_000).toISOString();
    expect(nextTimerTick(due, NOON)).toBe(20_000);
    expect(nextTimerTick(new Date(NOON - 1).toISOString(), NOON)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("times in the zone of the point", () => {
  it("says today's time alone, yesterday and tomorrow in words, other days by date", () => {
    expect(formatWhen("2026-10-06T08:40:00Z", ALMATY, "ru", t, NOON)).toBe("13:40");
    expect(formatWhen("2026-10-05T08:40:00Z", ALMATY, "ru", t, NOON)).toBe("вчера, 13:40");
    expect(formatWhen("2026-10-07T03:00:00Z", ALMATY, "ru", t, NOON)).toBe("завтра, 08:00");
    expect(formatWhen("2026-10-01T08:40:00Z", ALMATY, "ru", t, NOON)).toBe("1 октября, 13:40");
    // Just after midnight in Almaty is still «yesterday» in UTC.
    expect(formatWhen("2026-10-05T19:30:00Z", ALMATY, "ru", t, NOON)).toBe("00:30");
  });

  it("says a moment inside a sentence with its preposition, in three languages (TASK-033.A)", () => {
    const say = (lang: "ru" | "kk" | "en", iso: string) =>
      formatAt(iso, ALMATY, lang, (key, params) => supplierText(lang, key, params), NOON);
    const today = "2026-10-06T09:02:00Z";
    const yesterday = "2026-10-05T09:02:00Z";
    const tomorrow = "2026-10-07T09:02:00Z";
    const earlier = "2026-09-12T09:02:00Z";
    expect([today, yesterday, tomorrow, earlier].map((iso) => say("ru", iso))).toEqual([
      "в 14:02",
      "вчера в 14:02",
      "завтра в 14:02",
      "12 сентября в 14:02",
    ]);
    expect([today, yesterday, tomorrow, earlier].map((iso) => say("en", iso))).toEqual([
      "at 14:02",
      "yesterday at 14:02",
      "tomorrow at 14:02",
      "on September 12 at 14:02",
    ]);
    const kk = [today, yesterday, tomorrow, earlier].map((iso) => say("kk", iso));
    expect(kk.slice(0, 3)).toEqual(["14:02 кезінде", "кеше 14:02 кезінде", "ертең 14:02 кезінде"]);
    // The month by the platform's Kazakh data («12 қыркүйек»), then the time.
    expect(kk[3]).toMatch(/^12 \S+ 14:02 кезінде$/);
  });

  it("finds the start of today in the point's zone", () => {
    expect(new Date(startOfDay(ALMATY, NOON)).toISOString()).toBe("2026-10-05T19:00:00.000Z");
  });
});

describe("«В работе» in groups", () => {
  it("puts ready ones first by the end of the reserve, then accepted, then the late window", () => {
    const late = summary({ status: "reserve_expired", lateCloseUntil: "2026-10-07T07:00:00Z" });
    const passed = summary({ status: "reserve_expired", lateCloseUntil: null });
    const accepted = summary({ status: "accepted" });
    const readyLater = summary({ status: "ready", reserveUntil: "2026-10-06T15:00:00Z" });
    const readySooner = summary({ status: "ready", reserveUntil: "2026-10-06T10:00:00Z" });
    const groups = workGroups([late, accepted, readyLater, passed, readySooner]);
    expect(groups.map((group) => [group.group, group.orders.map((order) => order.id)])).toEqual([
      ["awaitingPickup", [readySooner.id, readyLater.id]],
      ["preparing", [accepted.id]],
      ["lateClose", [late.id]],
    ]);
    expect(workGroups([])).toEqual([]);
  });

  it("lights up only what came since the previous answer", () => {
    expect(arrivedIds(null, ["a", "b"])).toEqual([]);
    expect(arrivedIds(new Set(["a"]), ["a", "b", "c"])).toEqual(["b", "c"]);
  });
});

describe("«Завершённые» narrowed", () => {
  it("asks by status and from the start of the period's first day", () => {
    expect(finishedQuery({ period: "all", status: null }, ALMATY, NOON)).toEqual({});
    expect(finishedQuery({ period: "today", status: "completed" }, ALMATY, NOON)).toEqual({
      status: "completed",
      from: "2026-10-05T19:00:00.000Z",
    });
    expect(finishedQuery({ period: "week", status: null }, ALMATY, NOON)).toEqual({
      from: "2026-09-29T19:00:00.000Z",
    });
  });
});

describe("the buttons of an order (S-ORD-02, rows «Наличие» and «Любой»)", () => {
  const open = { blocked: false };
  it("offers exactly what the server allows from each status", () => {
    expect(orderActions(summary({ status: "created" }), NOON, open)).toEqual({
      primary: "accept",
      secondary: ["decline"],
    });
    expect(orderActions(summary({ status: "accepted" }), NOON, open)).toEqual({
      primary: "markReady",
      secondary: ["giveOut", "decline"],
    });
    expect(orderActions(summary({ status: "ready" }), NOON, open)).toEqual({
      primary: "giveOut",
      secondary: ["decline"],
    });
    expect(
      orderActions(
        summary({ status: "reserve_expired", lateCloseUntil: "2026-10-07T07:00:00Z" }),
        NOON,
        open,
      ),
    ).toEqual({ primary: "closeLate", secondary: [] });
    for (const status of [
      "completed",
      "cancelled_by_user",
      "declined_by_supplier",
      "response_expired",
      "reserve_expired",
    ] as const) {
      expect(orderActions(summary({ status }), NOON, open)).toEqual({
        primary: null,
        secondary: [],
      });
    }
  });

  it("takes «Принять» away once the answer deadline passed, and the late close at its edge", () => {
    const due = summary({ status: "created", respondBy: new Date(NOON).toISOString() });
    expect(orderActions(due, NOON, open).primary).toBeNull();
    const edge = summary({
      status: "reserve_expired",
      lateCloseUntil: new Date(NOON).toISOString(),
    });
    expect(orderActions(edge, NOON, open).primary).toBeNull();
  });

  it("leaves a blocked company looking at its orders and giving them out, nothing else (SCREENS 6.0)", () => {
    const blocked = { blocked: true };
    expect(orderActions(summary({ status: "created" }), NOON, blocked).primary).toBeNull();
    expect(orderActions(summary({ status: "accepted" }), NOON, blocked)).toEqual({
      primary: "giveOut",
      secondary: [],
    });
    expect(orderActions(summary({ status: "ready" }), NOON, blocked)).toEqual({
      primary: "giveOut",
      secondary: [],
    });
  });

  it("has no buttons for an order of a kind this version doesn't know", () => {
    const later = summary({ kind: "rental" as SupplierOrderSummary["kind"] });
    expect(orderActions(later, NOON, open)).toEqual({ primary: null, secondary: [] });
  });

  it("gives a service the buttons it shares with goods until TASK-039.B (TASK-038)", () => {
    const service = (status: SupplierOrderSummary["status"], blocked = false) =>
      orderActions(
        summary({
          kind: "service",
          status,
          lateCloseUntil:
            status === "visit_unresolved" ? new Date(NOON + 60 * MINUTE).toISOString() : null,
        }),
        NOON,
        { blocked },
      );
    // «Подтвердить время» · «Отказать» — «Предложить другое время» comes with its screen.
    expect(service("created")).toEqual({ primary: "accept", secondary: ["decline"] });
    expect(service("term_proposed")).toEqual({ primary: null, secondary: ["decline"] });
    // «Отметить выполнение по QR / коду» · «Отказать»; no «Готово к выдаче».
    expect(service("accepted")).toEqual({ primary: "giveOut", secondary: ["decline"] });
    expect(service("accepted", true)).toEqual({ primary: "giveOut", secondary: [] });
    expect(service("visit_unresolved")).toEqual({ primary: "closeLate", secondary: [] });
    expect(service("no_show")).toEqual({ primary: null, secondary: [] });
  });

  it("says a service in its own words and keeps confirmed visits apart by time (TASK-038)", () => {
    expect(t(statusKey("accepted", "service"))).toBe("Подтверждена");
    expect(t(statusKey("no_show", "service"))).toBe("Неявка клиента");
    expect(t(statusKey("visit_unresolved", "service"))).toBe("Запись не разобрана");
    const visit = (visitAt: string) => ({
      car: {
        make: { id: crypto.randomUUID(), label: "Geely" },
        model: { id: crypto.randomUUID(), label: "Coolray" },
        year: 2024,
      },
      timeZone: ALMATY,
      desiredAt: visitAt,
      proposed: null,
      confirmed: { visitAt, at: new Date(NOON).toISOString(), until: visitAt },
    });
    const later = summary({
      kind: "service",
      status: "accepted",
      serviceVisit: visit("2026-10-07T10:00:00.000Z"),
    });
    const sooner = summary({
      kind: "service",
      status: "accepted",
      serviceVisit: visit("2026-10-06T10:00:00.000Z"),
    });
    const goods = summary({ status: "accepted" });
    expect(workGroupOf(later)).toBe("services");
    expect(workGroupOf(goods)).toBe("preparing");
    const groups = workGroups([later, goods, sooner]);
    expect(groups.map((group) => group.group)).toEqual(["preparing", "services"]);
    expect(groups[1]!.orders.map((order) => order.id)).toEqual([sooner.id, later.id]);
    const words = visitWords(later, () => "7 октября, 15:00", t);
    expect(words).toEqual({ car: "Geely Coolray 2024", time: "Подтверждено: 7 октября, 15:00" });
    expect(visitWords(goods, () => "", t)).toBeNull();
    const proposed = visitWords(
      {
        status: "term_proposed",
        serviceVisit: {
          ...visit("2026-10-07T10:00:00.000Z"),
          confirmed: null,
          proposed: {
            visitAt: "2026-10-07T10:00:00.000Z",
            at: new Date(NOON).toISOString(),
            answerBy: "2026-10-07T05:00:00.000Z",
          },
        },
      },
      () => "завтра, 15:00",
      t,
    );
    expect(proposed?.time).toMatch(/^Предложено другое время: .+ Клиент ответит до /);
    const lines = journalLines(
      [
        {
          id: "e1",
          action: "accept",
          fromStatus: "created",
          toStatus: "accepted",
          at: new Date(NOON).toISOString(),
          actor: { kind: "member", memberId: crypto.randomUUID(), name: "Ерлан", removed: false },
          channel: "whatsapp",
          details: {},
        },
        {
          id: "e2",
          action: "mark_no_show",
          fromStatus: "accepted",
          toStatus: "no_show",
          at: new Date(NOON).toISOString(),
          actor: { kind: "member", memberId: crypto.randomUUID(), name: "Айжан", removed: false },
          channel: "supplier_web",
          details: {},
        },
      ],
      () => "12:00",
      t,
      (date) => date,
      "service",
    );
    expect(lines.map((line) => line.text)).toEqual([
      "Подтвердил время Ерлан, 12:00 (через WhatsApp)",
      "Неявка клиента — Айжан, 12:00",
    ]);
  });

  it("gives an order under order its buttons of S-ORD-02 (TASK-037, TASK-039, D-072)", () => {
    const onOrder = (status: SupplierOrderSummary["status"]) =>
      orderActions(summary({ kind: "on_order", status }), NOON, open);
    expect(onOrder("created")).toEqual({
      primary: "accept",
      secondary: ["proposeTerm", "decline"],
    });
    expect(onOrder("accepted")).toEqual({
      primary: "markReady",
      secondary: ["giveOut", "decline"],
    });
    expect(onOrder("ready")).toEqual({ primary: "giveOut", secondary: ["decline"] });
    // D-072: while the customer decides — only «Отказать».
    expect(onOrder("term_proposed")).toEqual({ primary: null, secondary: ["decline"] });
    expect(onOrder("term_expired")).toEqual({ primary: null, secondary: [] });
    // A blocked company gives out by the code, nothing else.
    const blocked = { blocked: true };
    expect(
      orderActions(summary({ kind: "on_order", status: "term_proposed" }), NOON, blocked),
    ).toEqual({ primary: null, secondary: [] });
    expect(orderActions(summary({ kind: "on_order", status: "created" }), NOON, blocked)).toEqual({
      primary: null,
      secondary: [],
    });
  });

  it("marks an overdue supply only while the term is confirmed and not ready (TASK-039)", () => {
    const overdue = {
      expected: { leadDays: 3, readyOn: "2026-10-09" },
      proposed: null,
      confirmed: { leadDays: 3, readyOn: "2026-10-09", at: "2026-10-06T07:00:00Z" },
      overdueSince: "2026-10-09T19:00:00Z",
    };
    expect(
      supplyOverdue(summary({ kind: "on_order", status: "accepted", onOrderTerm: overdue })),
    ).toBe(true);
    expect(
      supplyOverdue(summary({ kind: "on_order", status: "ready", onOrderTerm: overdue })),
    ).toBe(false);
    expect(
      supplyOverdue(
        summary({
          kind: "on_order",
          status: "accepted",
          onOrderTerm: { ...overdue, overdueSince: null },
        }),
      ),
    ).toBe(false);
  });

  it("says the dates of another term short, and a refused date apart from a conflict", () => {
    expect(formatTermDay("2026-10-12", "ru")).toMatch(/12/);
    expect(formatTermDay("2026-10-12", "ru")).toMatch(/пн/i);
    const refused = proposeProblem(
      new ApiError({ status: 400, code: "VALIDATION_ERROR", message: "no", retryable: false }),
      () => "",
      t,
    );
    expect(refused).toEqual({
      conflict: false,
      stale: true,
      text: "Эту дату больше нельзя предложить. Выберите дату из обновлённого списка",
    });
    const conflict = proposeProblem(
      new ApiError({
        status: 409,
        code: "ORDER_STATE_CONFLICT",
        message: "moved",
        retryable: false,
        details: {
          currentStatus: "accepted",
          version: 2,
          lastAction: {
            action: "accept",
            at: "2026-10-06T09:02:00Z",
            actor: { kind: "member", memberId: crypto.randomUUID(), name: "Марат", removed: false },
          },
        },
      }),
      () => "в 14:02",
      t,
    );
    expect(conflict.conflict).toBe(true);
    expect(conflict.text).toContain("Марат");
  });
});

describe("an order under order in words (TASK-037)", () => {
  const format = (iso: string) => formatWhen(iso, ALMATY, "ru", t, NOON);
  const day = (date: string) => formatDate(date, "ru");
  const term = {
    expected: { leadDays: 3, readyOn: "2026-10-09" },
    proposed: null,
    confirmed: null,
    overdueSince: null,
  };

  it("names its statuses and puts the one waiting for the customer in its own group", () => {
    expect(t(statusKey("accepted", "on_order"))).toBe("Срок подтверждён");
    expect(t(statusKey("accepted", "stock"))).toBe("Принята");
    expect(t(statusKey("term_proposed"))).toBe("Ждёт ответа клиента");
    expect(t(statusKey("term_expired"))).toBe("Клиент не ответил на срок");
    expect(workGroupOf(summary({ status: "term_proposed" }))).toBe("awaitingCustomer");
  });

  it("says the term: expected, proposed with the customer's deadline, confirmed, overdue", () => {
    expect(termWords(summary({ onOrderTerm: null }), day, format, t)).toBeNull();
    expect(termWords(summary({ kind: "on_order", onOrderTerm: term }), day, format, t)).toEqual({
      text: "Под заказ: 3 раб. дн., до 9 октября",
      note: null,
    });
    const proposed = {
      ...term,
      proposed: {
        leadDays: 5,
        readyOn: "2026-10-11",
        at: "2026-10-06T07:00:00Z",
        answerBy: "2026-10-06T10:00:00Z",
      },
    };
    expect(
      termWords(
        summary({ kind: "on_order", status: "term_proposed", onOrderTerm: proposed }),
        day,
        format,
        t,
      )!.text,
    ).toBe("Предложен другой срок: 5 раб. дн., до 11 октября. Клиент ответит до 15:00");
    expect(
      termWords(
        summary({
          kind: "on_order",
          status: "accepted",
          onOrderTerm: {
            ...proposed,
            confirmed: { leadDays: 5, readyOn: "2026-10-11", at: "2026-10-06T08:00:00Z" },
            overdueSince: "2026-10-11T19:00:00Z",
          },
        }),
        day,
        format,
        t,
      ),
    ).toEqual({
      text: "Срок подтверждён: 5 раб. дн., до 11 октября",
      note: "Срок поставки прошёл, а заявка ещё не готова к выдаче",
    });
  });

  it("names the moves of the term in the journal and in a conflict", () => {
    const lines = journalLines(
      [
        {
          id: "e1",
          action: "propose_term",
          fromStatus: "created",
          toStatus: "term_proposed",
          at: "2026-10-06T07:02:00Z",
          actor: { kind: "member", memberId: crypto.randomUUID(), name: "Ерлан", removed: false },
          channel: "supplier_web",
          details: { leadDays: 5, readyOn: "2026-10-11" },
        },
        {
          id: "e2",
          action: "agree_term",
          fromStatus: "term_proposed",
          toStatus: "accepted",
          at: "2026-10-06T07:30:00Z",
          actor: { kind: "user" },
          channel: "app",
          details: { leadDays: 5, readyOn: "2026-10-11" },
        },
      ],
      format,
      t,
      day,
    );
    expect(lines.map((line) => line.text)).toEqual([
      "Другой срок — Ерлан, 12:02: 5 раб. дн., до 11 октября",
      "Клиент согласился на срок, 12:30",
    ]);
    expect(
      conflictText(
        {
          currentStatus: "term_proposed",
          version: 2,
          lastAction: {
            action: "propose_term",
            at: "2026-10-06T07:02:00Z",
            actor: { kind: "member", memberId: crypto.randomUUID(), name: "Ерлан", removed: false },
          },
        },
        (iso) => formatAt(iso, ALMATY, "ru", t, NOON),
        t,
      ),
    ).toBe("Другой срок уже предложил Ерлан в 12:02");
  });
});

describe("a conflict is a notice naming who acted (PRODUCT 12.6)", () => {
  const at = "2026-10-06T07:02:00Z";
  const format = (iso: string) => formatAt(iso, ALMATY, "ru", t, NOON);
  const member = {
    kind: "member" as const,
    memberId: crypto.randomUUID(),
    name: "Ерлан",
    removed: false,
  };
  const details = (action: string, actor: object = member) => ({
    currentStatus: "accepted",
    version: 2,
    lastAction: { action, at, actor },
  });

  it("says what the colleague, the client, the administrator or the clock did", () => {
    expect(conflictText(details("accept"), format, t)).toBe("Заявку уже принял Ерлан в 12:02");
    expect(conflictText(details("decline"), format, t)).toBe("Заявку уже отклонил Ерлан в 12:02");
    expect(conflictText(details("close"), format, t)).toBe("Заявку уже выдал Ерлан в 12:02");
    expect(conflictText(details("cancel", { kind: "user" }), format, t)).toBe(
      "Клиент отменил заявку в 12:02",
    );
    expect(
      conflictText(
        details("admin_close", { kind: "admin", adminId: crypto.randomUUID() }),
        format,
        t,
      ),
    ).toBe("Заявку закрыл администратор клуба в 12:02");
    expect(conflictText(details("expire_no_response", { kind: "system" }), format, t)).toBe(
      "Срок ответа истёк в 12:02",
    );
    // Not «в вчера, 14:02» (TASK-033.A).
    const earlier = (iso: string) => ({
      ...details("accept"),
      lastAction: { action: "accept", at: iso, actor: member },
    });
    expect(conflictText(earlier("2026-10-05T09:02:00Z"), format, t)).toBe(
      "Заявку уже принял Ерлан вчера в 14:02",
    );
    expect(conflictText(earlier("2026-09-12T09:02:00Z"), format, t)).toBe(
      "Заявку уже принял Ерлан 12 сентября в 14:02",
    );
    expect(conflictText({ currentStatus: "accepted", version: 2 }, format, t)).toBe(
      "Заявка изменилась — посмотрите её текущий статус",
    );
    expect(conflictText("garbage", format, t)).toBe(
      "Заявка изменилась — посмотрите её текущий статус",
    );
  });

  it("says who moved an order seen moving on a re-read, and nothing when it stayed", () => {
    const accepted = {
      id: crypto.randomUUID(),
      action: "accept" as const,
      fromStatus: "created" as const,
      toStatus: "accepted" as const,
      at,
      actor: member,
      channel: "whatsapp" as const,
      details: {},
    };
    expect(
      changeNotice(
        { status: "created" },
        { status: "accepted", version: 2, events: [accepted] },
        format,
        t,
      ),
    ).toBe("Заявку уже принял Ерлан в 12:02");
    expect(
      changeNotice(
        { status: "accepted" },
        { status: "accepted", version: 3, events: [accepted] },
        format,
        t,
      ),
    ).toBeNull();
  });

  it("tells a conflict from an error of the press", () => {
    const conflict = new ApiError({
      code: "ORDER_STATE_CONFLICT",
      message: "x",
      status: 409,
      retryable: false,
      details: details("accept"),
    });
    expect(actionProblem(conflict, format, t)).toEqual({
      conflict: true,
      text: "Заявку уже принял Ерлан в 12:02",
    });
    const offline = new ApiError({
      code: "NETWORK_ERROR",
      message: "x",
      status: 0,
      retryable: true,
    });
    expect(actionProblem(offline, format, t).conflict).toBe(false);
    const limited = new ApiError({
      code: "RATE_LIMITED",
      message: "x",
      status: 429,
      retryable: true,
      details: { retryAfterSeconds: 90 },
    });
    expect(actionProblem(limited, format, t).text).toBe(
      "Слишком много запросов. Попробуйте через 2 мин",
    );
  });

  it("says the server's refusal to a blocked company in words, and asks for the company again (TASK-033.A)", () => {
    const blocked = new ApiError({
      code: "SUPPLIER_BLOCKED",
      message: "x",
      status: 403,
      retryable: false,
    });
    expect(actionProblem(blocked, format, t)).toEqual({
      conflict: true,
      companyChanged: true,
      text: "Кабинет заблокирован администратором клуба: принять, отметить готовность или отказать нельзя. Выдача по коду доступна",
    });
  });
});

describe("the journal in words (S-ORD-02)", () => {
  const format = (iso: string) => formatWhen(iso, ALMATY, "ru", t, NOON);
  const event = (overrides: Partial<OrderEvent>): OrderEvent => ({
    id: crypto.randomUUID(),
    action: "create",
    fromStatus: null,
    toStatus: "created",
    at: "2026-10-06T06:40:00Z",
    actor: { kind: "user" },
    channel: "app",
    details: {},
    ...overrides,
  });

  it("reads «Создана 11:40 · Принял Ерлан, 12:02 (через WhatsApp) · Готово — Айжан, …»", () => {
    const erlan = {
      kind: "member" as const,
      memberId: crypto.randomUUID(),
      name: "Ерлан",
      removed: false,
    };
    const aizhan = {
      kind: "member" as const,
      memberId: crypto.randomUUID(),
      name: "Айжан",
      removed: false,
    };
    const lines = journalLines(
      [
        event({}),
        event({ action: "accept", at: "2026-10-06T07:02:00Z", actor: erlan, channel: "whatsapp" }),
        event({ action: "late_action_ignored", actor: aizhan, channel: "supplier_web" }),
        event({ action: "reserve_expiring", actor: { kind: "system" }, channel: "timer" }),
        event({
          action: "mark_ready",
          at: "2026-10-06T11:10:00Z",
          actor: aizhan,
          channel: "supplier_web",
        }),
        event({
          action: "close",
          at: "2026-10-06T11:30:00Z",
          actor: aizhan,
          channel: "supplier_web",
          details: { closeMethod: "qr" },
        }),
      ],
      format,
      t,
    ).map((line) => line.text);
    expect(lines).toEqual([
      "Создана 11:40",
      "Принял Ерлан, 12:02 (через WhatsApp)",
      "Готово — Айжан, 16:10",
      "Выдана по QR — Айжан, 16:30",
    ]);
    // TASK-039: the same accept of an order under order is «Подтвердил срок».
    const onOrder = journalLines(
      [
        event({
          action: "accept",
          at: "2026-10-06T07:02:00Z",
          actor: erlan,
          channel: "supplier_web",
        }),
      ],
      format,
      t,
      (date) => date,
      "on_order",
    ).map((line) => line.text);
    expect(onOrder).toEqual(["Подтвердил срок Ерлан, 12:02"]);
  });

  it("names the administrator's close and the reason of a decline", () => {
    const lines = journalLines(
      [
        event({
          action: "decline",
          actor: { kind: "member", memberId: crypto.randomUUID(), name: "Марат", removed: false },
          details: { reason: "out_of_stock" },
          channel: "supplier_web",
        }),
        event({
          action: "admin_close",
          actor: { kind: "admin", adminId: crypto.randomUUID() },
          channel: "admin",
        }),
      ],
      format,
      t,
    ).map((line) => line.text);
    expect(lines).toEqual([
      "Отказ — Марат, 11:40 · Нет в наличии",
      "Закрыта администратором, 11:40",
    ]);
  });
});

describe("the customer's channels", () => {
  it("opens WhatsApp on the customer's number", () => {
    expect(whatsappLink("+77011234567")).toBe("https://wa.me/77011234567");
  });
});
