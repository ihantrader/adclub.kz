import { ApiError, type ApiErrorCode } from "@adclub/api-client";
import type {
  SupplierCardBinding,
  SupplierCharge,
  SupplierPaymentCard,
  SupplierSubscriptionResponse,
} from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { createTranslate } from "../translate";
import {
  billingActions,
  billingErrorText,
  billingKind,
  bindingFinished,
  bindingNotice,
  brandKey,
  chargeOutcomeText,
  chargeTone,
  dayText,
  declineKey,
  factsOf,
  maskText,
  mergeCharges,
  priceText,
  redirectTarget,
  replaceHead,
  stateBadge,
  stateTexts,
  termText,
} from "./billing-rules";

/** The cabinet keeps a number with its word by a no-break space; the expectations read plain spaces. */
const plain = (text: string) => text.replaceAll(String.fromCharCode(0xa0), " ");
const plainly =
  (translate: ReturnType<typeof createTranslate>): ReturnType<typeof createTranslate> =>
  (key, params) =>
    plain(translate(key, params));
const t = plainly(createTranslate("ru", null));
const tk = plainly(createTranslate("kk", null));
const ZONE = "Asia/Almaty";

const card: SupplierPaymentCard = {
  mask: "4242",
  brand: "visa",
  expMonth: 12,
  expYear: 2029,
  expired: false,
  linkedAt: "2026-10-05T09:00:00.000Z",
};

function response(over: Partial<SupplierSubscriptionResponse> = {}): SupplierSubscriptionResponse {
  return {
    cardLinked: true,
    cardRequired: true,
    hiddenWithoutCard: false,
    plan: {
      code: "supplier-month",
      price: 1000,
      currency: "KZT",
      period: "month",
      validFrom: "2026-10-01T00:00:00.000Z",
    },
    announcedPlan: null,
    subscription: {
      status: "active",
      periodEnd: "2026-11-04T19:00:00.000Z",
      graceUntil: null,
      amount: 1000,
      nextChargeAt: "2026-11-05T05:00:00.000Z",
      lastDecline: null,
    },
    card,
    pauses: { admin: false, billing: false },
    actions: { canPayNow: false, inProgress: false, canStart: true },
    ...over,
  };
}

const pastDue = response({
  subscription: {
    status: "past_due",
    periodEnd: "2026-11-04T19:00:00.000Z",
    graceUntil: "2026-11-08T05:00:05.000Z",
    amount: 1000,
    nextChargeAt: "2026-11-06T05:00:00.000Z",
    lastDecline: { at: "2026-11-05T05:00:05.000Z", reason: "insufficient_funds" },
  },
  actions: { canPayNow: true, inProgress: false, canStart: true },
});

const paused = response({
  subscription: {
    status: "suspended",
    periodEnd: "2026-11-04T19:00:00.000Z",
    graceUntil: null,
    amount: 1000,
    nextChargeAt: null,
    lastDecline: { at: "2026-11-07T05:00:05.000Z", reason: "insufficient_funds" },
  },
  pauses: { admin: false, billing: true },
  actions: { canPayNow: true, inProgress: false, canStart: true },
});

const noCard = response({
  cardLinked: false,
  hiddenWithoutCard: true,
  subscription: null,
  card: null,
});

describe("which state of S-BILL-01 an answer is in", () => {
  it("reads the five states from the server's facts", () => {
    expect(billingKind(noCard)).toBe("no_card");
    expect(billingKind(response())).toBe("active");
    expect(billingKind(pastDue)).toBe("past_due");
    expect(billingKind(paused)).toBe("paused");
    // The card is linked and the worker is making the subscription.
    expect(billingKind(response({ subscription: null }))).toBe("activating");
  });

  it("is a pause by the billing flag even before the status is applied, but not by the administrator's", () => {
    expect(billingKind(response({ pauses: { admin: false, billing: true } }))).toBe("paused");
    // The administrator's pause says nothing about the money: the subscription is still active.
    expect(billingKind(response({ pauses: { admin: true, billing: false } }))).toBe("active");
  });

  it("gives each state its badge", () => {
    expect(stateBadge("active")).toMatchObject({ text: "billing.state.active", tone: "success" });
    expect(stateBadge("past_due")).toMatchObject({
      text: "billing.state.pastDue",
      tone: "warning",
    });
    expect(stateBadge("paused")).toMatchObject({ text: "billing.state.paused", tone: "danger" });
    expect(stateBadge("no_card").text).toBe("billing.state.noCard");
  });
});

describe("the buttons of each state", () => {
  it("offers «Привязать карту» without a card, «Сменить карту» with one", () => {
    expect(billingActions(noCard)).toEqual({ link: true, change: false, pay: null });
    expect(billingActions(response())).toEqual({ link: false, change: true, pay: null });
  });

  it("offers «Оплатить сейчас» after a refusal and «Оплатить» on a pause, when the server says it can be paid", () => {
    expect(billingActions(pastDue)).toEqual({ link: false, change: true, pay: "payNow" });
    expect(billingActions(paused)).toEqual({ link: false, change: true, pay: "pay" });
    // The server decides whether there is something to pay: an active subscription isn't.
    expect(billingActions(response()).pay).toBeNull();
  });
});

describe("the words of S-BILL-01 (SCREENS 6.8)", () => {
  it("says the active subscription: until when, how much a month, when the card is charged next", () => {
    expect(stateTexts(response(), ZONE, "ru", t)).toEqual([
      "Активна до 5 ноября · 1 000 ₸ в месяц",
      "Следующее списание — 5 ноября",
    ]);
  });

  it("says the refused charge as SCREENS words it, with the reason", () => {
    expect(stateTexts(pastDue, ZONE, "ru", t)).toEqual([
      "Не удалось списать оплату 5 ноября. Следующая попытка — 6 ноября. Если оплата не пройдёт до 8 ноября, предложения будут сняты с витрины",
      "Причина: недостаточно средств",
    ]);
  });

  it("says there will be no more automatic tries when none is left", () => {
    const last = response({
      ...pastDue,
      subscription: { ...pastDue.subscription!, nextChargeAt: null },
    });
    expect(stateTexts(last, ZONE, "ru", t)[0]).toBe(
      "Не удалось списать оплату 5 ноября. Автоматических попыток больше не будет. Если не оплатить до 8 ноября, предложения будут сняты с витрины",
    );
  });

  it("says the pause with what is to pay, and the missing card with the first charge", () => {
    expect(stateTexts(paused, ZONE, "ru", t)).toEqual([
      "Оплатите подписку — предложения вернутся на витрину. Карту можно сменить",
      "К оплате: 1 000 ₸",
    ]);
    expect(stateTexts(noCard, ZONE, "ru", t)[0]).toBe(
      "Подписка оформляется картой: при привязке пройдёт первое списание — 1 000 ₸, дальше карта списывается раз в месяц",
    );
    // No tariff yet: the subscription can't be started, and the cabinet says so.
    expect(stateTexts({ ...noCard, plan: null }, ZONE, "ru", t)[0]).toBe(
      "Подписка пока недоступна: тариф для поставщиков ещё не назначен. Мы сообщили администратору клуба",
    );
  });

  it("speaks Kazakh too, and goes by the company's time zone", () => {
    expect(stateTexts(response(), ZONE, "kk", tk)[0]).toBe(
      "5 қараша дейін белсенді · айына 1 000 ₸",
    );
    // 19:00 UTC on the fourth is 00:00 on the fifth in Almaty.
    expect(plain(dayText("2026-11-04T19:00:00.000Z", ZONE, "ru"))).toBe("5 ноября");
    expect(plain(dayText("2026-11-04T19:00:00.000Z", "UTC", "ru"))).toBe("4 ноября");
  });

  it("writes a sum with a no-break sign and a card as it is printed", () => {
    expect(plain(priceText(12_500))).toBe("12 500 ₸");
    expect(maskText(card)).toBe("•••• 4242");
    expect(termText({ expMonth: 3, expYear: 2031 })).toBe("03/31");
    expect(brandKey("mastercard")).toBe("billing.brand.mastercard");
  });
});

describe("the reasons of a bank's refusal in words", () => {
  it("has a text for every reason in all three languages", () => {
    const reasons = [
      "insufficient_funds",
      "card_expired",
      "card_blocked",
      "invalid_card",
      "do_not_honor",
      "declined_other",
    ] as const;
    for (const lang of ["ru", "kk", "en"] as const) {
      const translate = createTranslate(lang, null);
      for (const reason of reasons) {
        expect(translate(declineKey(reason))).not.toBe(declineKey(reason));
      }
    }
    expect(t(declineKey("card_expired"))).toBe("срок действия карты истёк");
    expect(t(declineKey("card_blocked"))).toBe("карта заблокирована банком");
  });
});

describe("the history of charges", () => {
  const base: SupplierCharge = {
    id: "9f4a7b3c-0c1e-4a52-8d5b-2f0e6a1b7c11",
    kind: "scheduled",
    outcome: "succeeded",
    declineReason: null,
    amount: 1000,
    currency: "KZT",
    periodFrom: "2026-10-04T19:00:00.000Z",
    periodTo: "2026-11-04T19:00:00.000Z",
    at: "2026-11-05T05:00:05.000Z",
    resolvedAt: "2026-11-05T05:00:06.000Z",
    retryAt: null,
  };

  it("words the outcome of a charge", () => {
    expect(chargeOutcomeText(base, t)).toBe("Оплачено");
    expect(
      chargeOutcomeText(
        { ...base, outcome: "declined", declineReason: "insufficient_funds", resolvedAt: base.at },
        t,
      ),
    ).toBe("Отказ: недостаточно средств");
    expect(chargeOutcomeText({ ...base, outcome: "in_progress", resolvedAt: null }, t)).toBe(
      "Ждём ответ платёжной системы",
    );
    expect(chargeTone(base)).toBe("success");
    expect(chargeTone({ ...base, outcome: "declined" })).toBe("danger");
    expect(chargeTone({ ...base, outcome: "in_progress" })).toBe("neutral");
  });

  it("adds a page without repeating a line, and replaces only the head with a fresh first page", () => {
    const line = (n: number): SupplierCharge => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    });
    const first = [line(1), line(2)];
    expect(mergeCharges(first, [line(2), line(3)]).map((c) => c.id.slice(-2))).toEqual([
      "01",
      "02",
      "03",
    ]);
    // Pages loaded below the first stay when the first is read again (the poll).
    const loaded = [line(1), line(2), line(3), line(4)];
    const fresh = [{ ...line(1), outcome: "declined" as const }, line(2)];
    const replaced = replaceHead(loaded, fresh, 2);
    expect(replaced.map((c) => c.id.slice(-2))).toEqual(["01", "02", "03", "04"]);
    expect(replaced[0]?.outcome).toBe("declined");
    // A list not longer than a page is simply replaced.
    expect(replaceHead(first, [line(5)], 2).map((c) => c.id.slice(-2))).toEqual(["05"]);
  });
});

describe("the return from the provider's page", () => {
  const binding = (over: Partial<SupplierCardBinding>): SupplierCardBinding => ({
    id: "b1b1b1b1-0c1e-4a52-8d5b-2f0e6a1b7c11",
    status: "pending",
    failure: null,
    card: null,
    subscriptionStatus: null,
    startedAt: "2026-11-05T05:00:00.000Z",
    expiresAt: "2026-11-05T06:00:00.000Z",
    ...over,
  });

  it("waits while the trip is under way, and the first charge is its own step", () => {
    expect(bindingNotice(binding({ status: "pending" }))).toEqual({
      kind: "progress",
      text: "billing.binding.waiting",
    });
    expect(bindingNotice(binding({ status: "card_received" })).kind).toBe("progress");
    expect(bindingNotice(binding({ status: "charging" }))).toEqual({
      kind: "progress",
      text: "billing.binding.charging",
    });
  });

  it("waits for the subscription after the card is linked, then says it is done", () => {
    expect(bindingNotice(binding({ status: "completed", card }))).toEqual({
      kind: "progress",
      text: "billing.binding.activating",
    });
    const done = bindingNotice(
      binding({ status: "completed", card, subscriptionStatus: "active" }),
    );
    expect(done).toEqual({ kind: "done", withDate: true });
    expect(bindingFinished(done)).toBe(true);
    // A card changed under a subscription that is not active: done, without a date.
    expect(
      bindingNotice(binding({ status: "completed", card, subscriptionStatus: "past_due" })),
    ).toEqual({ kind: "done", withDate: false });
  });

  it("says the bank's refusal with its reason, a provider that was away, and a page closed unfinished", () => {
    expect(bindingNotice(binding({ status: "declined", failure: "insufficient_funds" }))).toEqual({
      kind: "declined",
      reason: "insufficient_funds",
    });
    expect(bindingNotice(binding({ status: "failed", failure: "provider_unavailable" }))).toEqual({
      kind: "unavailable",
    });
    expect(bindingNotice(binding({ status: "abandoned", failure: "cancelled" }))).toEqual({
      kind: "abandoned",
    });
    expect(bindingNotice(binding({ status: "abandoned", failure: "expired" }))).toEqual({
      kind: "abandoned",
    });
    expect(bindingFinished({ kind: "abandoned" })).toBe(true);
    expect(bindingFinished({ kind: "progress", text: "billing.binding.waiting" })).toBe(false);
  });

  it("sends the browser to the provider's page, resolving the test provider's path against the API", () => {
    expect(redirectTarget("/dev/payment/card?ref=tb_1", "http://localhost:3000/")).toBe(
      "http://localhost:3000/dev/payment/card?ref=tb_1",
    );
    expect(redirectTarget("https://pay.example.kz/p/1", "http://localhost:3000")).toBe(
      "https://pay.example.kz/p/1",
    );
  });
});

describe("what the frame needs for T-SUP-02", () => {
  it("is a missing card only while the switch D-041 is on and no card is linked", () => {
    expect(factsOf({ cardRequired: true, cardLinked: false })).toEqual({ cardMissing: true });
    expect(factsOf({ cardRequired: true, cardLinked: true })).toEqual({ cardMissing: false });
    expect(factsOf({ cardRequired: false, cardLinked: false })).toEqual({ cardMissing: false });
  });
});

describe("the errors of the money actions in words", () => {
  const error = (code: ApiErrorCode, status: number, details?: unknown) =>
    new ApiError({ code, message: "m", status, retryable: false, details });

  it("says the provider's absence, the missing tariff and card, and a paid subscription", () => {
    expect(billingErrorText(error("SERVICE_UNAVAILABLE", 503), t)).toBe(
      "Не удалось связаться с платёжной системой. Попробуйте позже",
    );
    expect(billingErrorText(error("BILLING_NO_PLAN", 409), t)).toBe(
      "Подписка пока недоступна: тариф для поставщиков ещё не назначен. Мы сообщили администратору клуба",
    );
    expect(billingErrorText(error("BILLING_NO_CARD", 409), t)).toBe("Сначала привяжите карту");
    expect(billingErrorText(error("BILLING_NOTHING_TO_PAY", 409), t)).toBe(
      "Подписка оплачена — платить сейчас не нужно",
    );
  });

  it("says how long to wait after a limit, and has a plain text for the rest", () => {
    expect(billingErrorText(error("RATE_LIMITED", 429, { retryAfterSeconds: 130 }), t)).toBe(
      "Слишком много запросов. Попробуйте через 3 мин",
    );
    expect(billingErrorText(new Error("boom"), t)).toBe("Попробуйте ещё раз");
  });
});
