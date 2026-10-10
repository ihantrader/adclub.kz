import { ApiError } from "@adclub/api-client";
import { orderStatusSchema, type AdminOrder, type OrderEvent } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  eventText,
  ORDER_STATUS_TEXT,
  orderActions,
  orderActorText,
  orderErrorText,
  orderFiltersOf,
  orderKindText,
  orderStatusText,
  orderTermText,
} from "./order-words";

const deadlines = (reserveUntil: string | null = null): AdminOrder["deadlines"] => ({
  respondBy: "2026-10-10T10:00:00.000Z",
  reserveUntil,
  lateCloseUntil: null,
  termAnswerBy: null,
});

const conflict = (details: unknown) =>
  new ApiError({
    status: 409,
    code: "ORDER_STATE_CONFLICT",
    message: "conflict",
    retryable: false,
    details,
  });

describe("the words of «Заявки» (TASK-036.B)", () => {
  it("names every status of the contract", () => {
    for (const status of orderStatusSchema.options) {
      expect(ORDER_STATUS_TEXT[status], status).toBeTruthy();
    }
    expect(ORDER_STATUS_TEXT.cancelled_by_admin).toBe("Отменена администратором");
  });

  it("offers only the manual actions the one table of moves allows", () => {
    expect(orderActions({ kind: "stock", status: "created", deadlines: deadlines() })).toEqual({
      extendResponse: true,
      extendReserve: false,
      closeWithoutCode: true,
      cancel: true,
    });
    expect(
      orderActions({
        kind: "stock",
        status: "accepted",
        deadlines: deadlines("2026-10-11T10:00:00.000Z"),
      }),
    ).toEqual({ extendResponse: false, extendReserve: true, closeWithoutCode: true, cancel: true });
    // Delivery: no reserve to extend.
    expect(
      orderActions({ kind: "stock", status: "ready", deadlines: deadlines() }).extendReserve,
    ).toBe(false);
    // An expired order is closed by the administrator, never cancelled.
    expect(
      orderActions({ kind: "stock", status: "reserve_expired", deadlines: deadlines() }),
    ).toEqual({
      extendResponse: false,
      extendReserve: false,
      closeWithoutCode: true,
      cancel: false,
    });
    for (const status of [
      "completed",
      "cancelled_by_user",
      "declined_by_supplier",
      "cancelled_by_admin",
    ] as const) {
      expect(
        Object.values(orderActions({ kind: "stock", status, deadlines: deadlines() })),
        status,
      ).toEqual([false, false, false, false]);
    }
  });

  it("says an order under order in its own words (TASK-037)", () => {
    expect(orderStatusText({ status: "accepted", kind: "on_order" })).toBe("Срок подтверждён");
    expect(orderStatusText({ status: "accepted", kind: "stock" })).toBe("Принята");
    expect(ORDER_STATUS_TEXT.term_proposed).toBe("Ждёт ответа клиента на срок");
    expect(orderKindText("on_order")).toBe("Под заказ");
    expect(orderKindText("stock")).toBeNull();
    // The administrator may cancel or close it while the customer decides.
    expect(
      orderActions({ kind: "on_order", status: "term_proposed", deadlines: deadlines() }),
    ).toEqual({
      extendResponse: false,
      extendReserve: false,
      closeWithoutCode: true,
      cancel: true,
    });
    const term = {
      expected: { leadDays: 3, readyOn: "2026-10-13" },
      proposed: {
        leadDays: 5,
        readyOn: "2026-10-15",
        at: "2026-10-10T05:00:00.000Z",
        answerBy: "2026-10-11T05:00:00.000Z",
      },
      confirmed: null,
      overdueSince: null,
    };
    expect(orderTermText({ status: "created", onOrderTerm: null })).toBeNull();
    expect(orderTermText({ status: "created", onOrderTerm: { ...term, proposed: null } })).toBe(
      "Под заказ: 3 раб. дн., до 13 октября",
    );
    expect(orderTermText({ status: "term_proposed", onOrderTerm: term })).toMatch(
      /^Предложен другой срок: 5 раб\. дн\., до 15 октября; клиент ответит до /,
    );
    expect(
      orderTermText({
        status: "accepted",
        onOrderTerm: {
          ...term,
          confirmed: { leadDays: 5, readyOn: "2026-10-15", at: "2026-10-10T06:00:00.000Z" },
        },
      }),
    ).toBe("Срок подтверждён: 5 раб. дн., до 15 октября");
    expect(
      eventText({
        id: "e",
        action: "propose_term",
        fromStatus: "created",
        toStatus: "term_proposed",
        at: "2026-10-10T05:00:00.000Z",
        actor: { kind: "member", memberId: "m", name: "Ерлан", removed: false },
        channel: "supplier_web",
        details: { leadDays: 5, readyOn: "2026-10-15", answerBy: "2026-10-11T05:00:00.000Z" },
      }),
    ).toMatch(/^Предложен другой срок: 5 раб\. дн\., до 15 октября/);
  });

  it("names who acted and what was done, «через WhatsApp» apart", () => {
    const admins = new Map([["00000000-0000-4000-8000-000000000001", "Юрий"]]);
    expect(
      orderActorText({ kind: "admin", adminId: "00000000-0000-4000-8000-000000000001" }, admins),
    ).toBe("Юрий (администратор)");
    expect(orderActorText({ kind: "admin", adminId: "00000000-0000-4000-8000-000000000002" })).toBe(
      "Администратор клуба",
    );
    expect(orderActorText({ kind: "member", memberId: "x", name: "Марат", removed: true })).toBe(
      "Марат (удалён)",
    );
    const event = (
      action: OrderEvent["action"],
      details: OrderEvent["details"] = {},
    ): OrderEvent => ({
      id: "00000000-0000-4000-8000-000000000009",
      action,
      fromStatus: null,
      toStatus: null,
      at: "2026-10-10T10:00:00.000Z",
      actor: { kind: "system" },
      channel: "admin",
      details,
    });
    expect(eventText(event("admin_cancel"))).toBe("Отменена администратором");
    expect(eventText(event("decline", { reason: "out_of_stock", note: "Закончились" }))).toBe(
      "Отклонена: нет в наличии («Закончились»)",
    );
    expect(
      eventText(
        event("deadline_extended", {
          extendedDeadline: "response",
          minutes: 30,
          previousDeadline: "2026-10-10T10:00:00.000Z",
          deadline: "2026-10-10T10:30:00.000Z",
        }),
      ),
    ).toBe("Продлён срок ответа на 30 мин: 10 окт. 2026 г., 15:00 → 10 окт. 2026 г., 15:30");
  });

  it("says who acted first when the order moved under the administrator", () => {
    expect(
      orderErrorText(
        conflict({
          currentStatus: "completed",
          version: 3,
          lastAction: {
            action: "admin_close",
            at: "2026-10-10T10:00:00.000Z",
            actor: { kind: "admin", adminId: "00000000-0000-4000-8000-000000000001" },
          },
        }),
        new Map([["00000000-0000-4000-8000-000000000001", "Юрий"]]),
      ),
    ).toBe(
      "Заявку уже закрыли без кода — Юрий (администратор), 10 окт. 2026 г., 15:00. Сейчас: Выдана",
    );
    expect(
      orderErrorText(
        conflict({
          currentStatus: "response_expired",
          version: 2,
          lastAction: {
            action: "expire_no_response",
            at: "2026-10-10T10:00:00.000Z",
            actor: { kind: "system" },
          },
        }),
      ),
    ).toBe(
      "Заявка истекла: поставщик не ответил, 10 окт. 2026 г., 15:00. Сейчас: Нет ответа вовремя",
    );
  });

  it("keeps the filters of the list in the address, the period by the days of Almaty", () => {
    const filters = orderFiltersOf(
      new URLSearchParams(
        "q=1028&status=cancelled_by_admin&from=2026-10-07&test=include&closedLate=true",
      ),
    );
    expect(filters).toMatchObject({
      q: "1028",
      status: "cancelled_by_admin",
      from: "2026-10-06T19:00:00.000Z",
      test: "include",
      closedLate: "true",
    });
    expect(orderFiltersOf(new URLSearchParams("status=nonsense")).status).toBeUndefined();
    expect(orderFiltersOf(new URLSearchParams("")).test).toBe("exclude");
  });
});
