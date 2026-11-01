import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { paymentDeclineReasonSchema, type PaymentDeclineReason } from "@adclub/contracts";
import { z } from "zod";
import type { PaymentTestMode } from "../../config/env.schema";
import {
  PaymentProvider,
  PaymentProviderUnavailableError,
  PaymentWebhookError,
  type BindingLookup,
  type BindingStart,
  type BoundCard,
  type ChargeRequest,
  type ChargeResult,
  type ParsedPaymentWebhook,
  type PaymentLookup,
} from "./payment-provider";

/**
 * The cards of the test provider's page (`/dev/payment/card`, development
 * and tests): what a charge to each of them does. The page lists them by
 * these rows; the token carries the code, so a charge needs nothing but the
 * token (the provider is stateless about cards).
 */
export const TEST_CARDS = [
  {
    code: "ok",
    number: "4242 4242 4242 4242",
    brand: "visa",
    label: "Успешное списание",
  },
  {
    code: "insufficient_funds",
    number: "4000 0000 0000 9995",
    brand: "visa",
    label: "Отказ банка: недостаточно средств",
  },
  {
    code: "card_expired",
    number: "5100 0000 0000 0069",
    brand: "mastercard",
    label: "Отказ банка: карта просрочена",
  },
  {
    code: "provider_unavailable",
    number: "4000 0000 0000 0119",
    brand: "visa",
    label: "Платёжная система недоступна при списании",
  },
  {
    code: "outcome_unknown",
    number: "4000 0000 0000 0259",
    brand: "visa",
    label: "Исход неизвестен: списание прошло, ответ потерян",
  },
] as const;

export type TestCardCode = (typeof TEST_CARDS)[number]["code"];

const TOKEN_PREFIX = "tok_test_";

/** The test provider's token for a card (a secret in the real world; here only a scenario). */
export function testCardToken(code: TestCardCode): string {
  return `${TOKEN_PREFIX}${code}_${randomBytes(6).toString("hex")}`;
}

function scenarioOf(token: string): TestCardCode | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  return TEST_CARDS.map((card) => card.code).find((code) => rest.startsWith(`${code}_`)) ?? null;
}

/** The card the test page names, as the provider would hand it over. */
export function testBoundCard(code: TestCardCode, now: Date = new Date()): BoundCard {
  const card = TEST_CARDS.find((candidate) => candidate.code === code)!;
  const expired = code === "card_expired";
  return {
    token: testCardToken(code),
    mask: card.number.slice(-4),
    brand: card.brand,
    expMonth: expired ? 1 : 12,
    expYear: expired ? now.getUTCFullYear() - 5 : now.getUTCFullYear() + 3,
  };
}

/** The header the test provider signs its webhook in. */
export const PAYMENT_WEBHOOK_SIGNATURE_HEADER = "x-payment-signature";

export function signPaymentWebhook(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const cardSchema = z.object({
  token: z.string().min(1).max(200),
  mask: z.string().regex(/^[0-9]{4}$/),
  brand: z.enum(["visa", "mastercard", "other"]),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
});

const webhookSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(200),
    type: z.literal("card_bound"),
    ref: z.string().min(1),
    card: cardSchema,
  }),
  z.object({
    id: z.string().min(1).max(200),
    type: z.literal("card_cancelled"),
    ref: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1).max(200),
    type: z.literal("payment"),
    key: z.string().min(1).max(200),
    status: z.enum(["succeeded", "declined"]),
    reason: paymentDeclineReasonSchema.optional(),
    paymentId: z.string().min(1).max(200).optional(),
  }),
  z.object({ id: z.string().min(1).max(200), type: z.literal("ping") }),
]);

/** The webhook of the test provider, as the dev command and the tests write it. */
export type TestPaymentWebhook = z.input<typeof webhookSchema>;

type Recorded =
  | { kind: "succeeded"; providerPaymentId: string }
  | { kind: "declined"; reason: PaymentDeclineReason; providerPaymentId: string };

const SLOW_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The provider of development, tests and CI: nothing leaves the process.
 * It behaves like a processor that keeps payments by idempotency key:
 *
 * - the same key twice is one payment (`ledger`) — the second call returns
 *   the first result and charges nothing more;
 * - a charge to a card of `outcome_unknown` is recorded and then answers
 *   «unknown», as if the answer had been lost — it is found by `getPayment`;
 * - `mode` (`PAYMENT_TEST_MODE`, tests assign it) makes every call fail the
 *   way an unreachable provider does, or refuses every charge, or makes the
 *   answer slow.
 *
 * `charges` keeps every call of `charge` for the tests to count: «not twice
 * for a period» is checked against what the provider was asked, not against
 * our own tables.
 */
export class TestPaymentProvider extends PaymentProvider {
  readonly name = "test" as const;

  mode: PaymentTestMode = "ok";

  readonly ledger = new Map<string, Recorded>();
  readonly charges: ChargeRequest[] = [];
  readonly detached: string[] = [];
  private paymentCounter = 0;

  constructor(private readonly webhookSecret: string) {
    super();
  }

  /** Forgets everything the provider remembers (a test begins). */
  reset(): void {
    this.mode = "ok";
    this.ledger.clear();
    this.charges.length = 0;
    this.detached.length = 0;
  }

  private guard(): void {
    if (this.mode === "unavailable") {
      throw new PaymentProviderUnavailableError("The test payment provider is unavailable");
    }
  }

  async beginCardBinding(): Promise<BindingStart> {
    this.guard();
    const providerRef = `tb_${randomBytes(8).toString("hex")}`;
    return { providerRef, redirectUrl: `/dev/payment/card?ref=${providerRef}` };
  }

  async getCardBinding(): Promise<BindingLookup> {
    this.guard();
    // The page of the test provider tells us itself (it writes the card into the binding).
    return { kind: "pending" };
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(request);
    if (this.mode === "unavailable") {
      return { kind: "unavailable", detail: "The test payment provider is unavailable" };
    }
    if (this.mode === "slow") await sleep(SLOW_MS);
    const known = this.ledger.get(request.idempotencyKey);
    if (known) {
      return known.kind === "succeeded"
        ? { kind: "succeeded", providerPaymentId: known.providerPaymentId }
        : {
            kind: "declined",
            reason: known.reason,
            providerPaymentId: known.providerPaymentId,
          };
    }
    const scenario = scenarioOf(request.token);
    // A card forgotten at the provider is no card any more, as at a real processor.
    if (scenario === null || this.detached.includes(request.token)) {
      return { kind: "declined", reason: "invalid_card", providerPaymentId: null };
    }
    if (scenario === "provider_unavailable") {
      return { kind: "unavailable", detail: "The bank's gateway did not answer" };
    }
    const paymentId = `tp_${(++this.paymentCounter).toString().padStart(6, "0")}_${randomBytes(3).toString("hex")}`;
    const refusal: PaymentDeclineReason | null =
      this.mode === "declined"
        ? "insufficient_funds"
        : scenario === "insufficient_funds"
          ? "insufficient_funds"
          : scenario === "card_expired"
            ? "card_expired"
            : null;
    if (refusal) {
      this.ledger.set(request.idempotencyKey, {
        kind: "declined",
        reason: refusal,
        providerPaymentId: paymentId,
      });
      return { kind: "declined", reason: refusal, providerPaymentId: paymentId };
    }
    this.ledger.set(request.idempotencyKey, { kind: "succeeded", providerPaymentId: paymentId });
    if (this.mode === "outcome_unknown" || scenario === "outcome_unknown") {
      // Charged at the provider; the answer is lost on the way.
      return { kind: "unknown", detail: "The answer was lost" };
    }
    return { kind: "succeeded", providerPaymentId: paymentId };
  }

  async getPayment(idempotencyKey: string): Promise<PaymentLookup> {
    if (this.mode === "unavailable") {
      return { kind: "unavailable", detail: "The test payment provider is unavailable" };
    }
    const known = this.ledger.get(idempotencyKey);
    if (!known) return { kind: "not_found" };
    return known.kind === "succeeded"
      ? { kind: "succeeded", providerPaymentId: known.providerPaymentId }
      : { kind: "declined", reason: known.reason, providerPaymentId: known.providerPaymentId };
  }

  async detachCard(token: string): Promise<void> {
    this.guard();
    this.detached.push(token);
  }

  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string | undefined>>): boolean {
    const given = headers[PAYMENT_WEBHOOK_SIGNATURE_HEADER];
    if (!given) return false;
    const expected = signPaymentWebhook(this.webhookSecret, rawBody);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer): ParsedPaymentWebhook {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new PaymentWebhookError("The webhook is not JSON");
    }
    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) {
      throw new PaymentWebhookError(
        `Not a test provider webhook: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
      );
    }
    const event = parsed.data;
    switch (event.type) {
      case "card_bound":
        return { kind: "card_bound", eventId: event.id, providerRef: event.ref, card: event.card };
      case "card_cancelled":
        return { kind: "card_cancelled", eventId: event.id, providerRef: event.ref };
      case "payment":
        return {
          kind: "payment",
          eventId: event.id,
          idempotencyKey: event.key,
          result: event.status,
          reason: event.status === "declined" ? (event.reason ?? "declined_other") : null,
          providerPaymentId: event.paymentId ?? null,
        };
      case "ping":
        return { kind: "ignored", eventId: event.id };
    }
  }
}
