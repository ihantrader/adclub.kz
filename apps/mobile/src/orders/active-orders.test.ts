import { describe, expect, it } from "vitest";
import { mainDateText, orderActiveOrders, qrPages } from "./active-orders";
import { activeOrder, SUPPLIER_A, SUPPLIER_B } from "./order-fixtures";
import { orderViewOfCopy } from "./order-view";

// Plain Node checks of «Активные» (M-ORD-02) and the leafing of M-ORD-04 (TASK-030, AC-5, AC-6).

const month = (n: number) =>
  [
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
  ][n - 1]!;

describe("the order of active orders", () => {
  it("puts «Нужен ваш ответ» first, then «Можно забирать», then keeps the server's order", () => {
    const waiting = activeOrder({ status: "created", awaitsReceipt: false });
    const accepted = activeOrder({ status: "accepted" });
    const ready = activeOrder({ status: "ready" });
    const answer = activeOrder({ status: "accepted", needsAnswer: true });
    const sorted = orderActiveOrders([waiting, accepted, ready, answer]);
    expect(sorted.map((order) => order.id)).toEqual([answer.id, ready.id, waiting.id, accepted.id]);
  });

  it("changes nothing in an answer already in that order — the screen and the copy are one list", () => {
    const list = [
      activeOrder({ status: "ready" }),
      activeOrder({ status: "ready" }),
      activeOrder({ status: "created" }),
      activeOrder({ status: "accepted" }),
    ];
    expect(orderActiveOrders(list)).toEqual(list);
    expect(orderActiveOrders([])).toEqual([]);
  });
});

describe("the main date of a card", () => {
  const now = new Date("2026-10-04T05:00:00.000Z"); // 10:00 in Almaty

  it("says «Резерв до 15:00, 15 марта» on another day and only the time on this one, in the point's zone", () => {
    expect(
      mainDateText(
        { kind: "reserve_until", at: "2026-10-05T10:00:00.000Z" },
        "Asia/Almaty",
        now,
        month,
      ),
    ).toEqual({ key: "orders.mainDate.reserveUntil", time: "15:00, 5 октября" });
    expect(
      mainDateText(
        { kind: "respond_by", at: "2026-10-04T09:30:00.000Z" },
        "Asia/Almaty",
        now,
        month,
      ),
    ).toEqual({ key: "orders.mainDate.respondBy", time: "14:30" });
    // TASK-037: «Ответьте до …» while another term waits for the user.
    expect(
      mainDateText(
        { kind: "answer_by", at: "2026-10-04T09:30:00.000Z" },
        "Asia/Almaty",
        now,
        month,
      ),
    ).toEqual({ key: "orders.mainDate.answerBy", time: "14:30" });
  });

  it("says a confirmed visit with its date always — «Ждём вас 4 октября в 15:00» (TASK-039.B)", () => {
    const words = (date: string, time: string) => `${date} в ${time}`;
    expect(
      mainDateText(
        { kind: "visit_at", at: "2026-10-04T10:00:00.000Z" },
        "Asia/Almaty",
        now,
        month,
        words,
      ),
    ).toEqual({ key: "orders.mainDate.visitAt", time: "4 октября в 15:00" });
    expect(
      mainDateText({ kind: "visit_at", at: "not a time" }, "Asia/Almaty", now, month, words),
    ).toBeNull();
  });

  it("reads a copy saved before orders under order existed as one in stock (TASK-037)", () => {
    const old = activeOrder();
    delete (old as Partial<typeof old>).onOrderTerm;
    delete (old as Partial<typeof old>).kind;
    const view = orderViewOfCopy(old);
    expect(view.kind).toBe("stock");
    expect(view.onOrderTerm).toBeNull();
  });

  it("has nothing to say when the server named no date (delivery)", () => {
    expect(mainDateText(null, "Asia/Almaty", now, month)).toBeNull();
  });
});

describe("leafing the full-screen QR", () => {
  it("leafs through the orders of the same supplier that wait to be received, starting at the opened one", () => {
    const a1 = orderViewOfCopy(activeOrder());
    const a2 = orderViewOfCopy(activeOrder());
    const b = orderViewOfCopy(
      activeOrder({
        supplier: { id: SUPPLIER_B, name: "Другой", cityName: "Алматы", district: null },
      }),
    );
    const waiting = orderViewOfCopy(activeOrder({ status: "created", awaitsReceipt: false }));
    const { pages, index } = qrPages(a2, [a1, b, a2, waiting]);
    expect(pages.map((order) => order.id)).toEqual([a1.id, a2.id]);
    expect(index).toBe(1);
    expect(pages.every((order) => order.supplier.id === SUPPLIER_A)).toBe(true);
  });

  it("shows the opened order even before the copy holds it, and as it was just loaded", () => {
    const fresh = orderViewOfCopy(activeOrder());
    const kept = orderViewOfCopy(activeOrder());
    expect(qrPages(fresh, [kept]).pages.map((order) => order.id)).toEqual([fresh.id, kept.id]);
    const newer = { ...kept, status: "ready" as const };
    expect(qrPages(newer, [kept]).pages[0]).toBe(newer);
  });
});
