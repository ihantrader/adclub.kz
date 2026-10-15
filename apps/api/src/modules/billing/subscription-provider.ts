import { providerEventKinds, type ProviderEventKind } from "@adclub/domain";
import { z } from "zod";
import type { SubscriptionProviderName } from "./schema";

/**
 * A provider's event in our general words (ARCHITECTURE 9.4.1 rules 3, 9;
 * 4.72): what a store's notification, a processor's webhook or the test
 * provider's operator command says, after the provider's implementation
 * read it. The table of a provider's own names of events is that
 * implementation — one place per provider.
 */
export interface NormalizedProviderEvent {
  /** The event's id at the provider: the same id twice is one event. */
  providerEventId: string;
  kind: ProviderEventKind;
  /** The purchase (a store's original transaction id, a processor's subscription id). */
  providerRef: string;
  /**
   * The account the provider says the purchase is for (`appAccountToken`,
   * `obfuscatedExternalAccountId` — our account id); `null` — the provider
   * doesn't say (a later notification names only the purchase).
   */
  accountId: string | null;
  /** When it happened at the provider: the order events are applied in. */
  eventAt: Date;
  periodEnd: Date | null;
  graceUntil: Date | null;
  platform: "ios" | "android" | null;
}

/** A purchase the provider confirmed (the purchase routes of TASK-041). */
export interface VerifiedPurchase {
  providerRef: string;
  periodEnd: Date;
  platform: "ios" | "android" | null;
  eventAt: Date;
}

/** The provider refused a purchase or an event: not ours, forged, malformed. */
export class SubscriptionProviderError extends Error {}

/**
 * The port of a subscription provider (ARCHITECTURE 9.4.1 rule 9): checking
 * a purchase with the provider and reading its event into our words. The
 * statuses and the rules of access are the billing module's, the same for
 * every provider. Implementations: `TestSubscriptionProvider` (development,
 * tests and CI — no outside call); the stores (or RevenueCat) — TASK-041;
 * a card processor — TASK-042.
 */
export interface SubscriptionProvider {
  readonly name: SubscriptionProviderName;
  /** Checks a purchase the client reports with the provider itself; the client's word is never taken. */
  verifyPurchase(accountId: string, purchase: unknown): Promise<VerifiedPurchase>;
  /** Reads one event of the provider; refuses what isn't one. */
  parseEvent(raw: unknown): NormalizedProviderEvent;
}

const testEventSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(providerEventKinds),
  ref: z.string().min(1).max(200),
  accountId: z.uuid().nullable().optional(),
  at: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }).optional(),
  graceUntil: z.iso.datetime({ offset: true }).optional(),
  platform: z.enum(["ios", "android"]).optional(),
});

/** The test provider's event, as the operator command and the tests write it. */
export type TestProviderEvent = z.input<typeof testEventSchema>;

const testPurchaseSchema = z.object({
  ref: z.string().min(1).max(200),
  periodEnd: z.iso.datetime({ offset: true }),
  platform: z.enum(["ios", "android"]).optional(),
});

/**
 * The provider of development, tests and CI: nothing leaves the process. Its
 * events are written by the operator command `dev:subscription:event` and by
 * the tests, already in our words; a «purchase» is `{ref, periodEnd}`. It
 * checks the shape and nothing else — it is not for production (the command
 * that feeds it runs only in development and tests).
 */
export class TestSubscriptionProvider implements SubscriptionProvider {
  readonly name = "test" as const;

  verifyPurchase(_accountId: string, purchase: unknown): Promise<VerifiedPurchase> {
    const parsed = testPurchaseSchema.safeParse(purchase);
    if (!parsed.success) {
      return Promise.reject(new SubscriptionProviderError("Not a test purchase"));
    }
    return Promise.resolve({
      providerRef: parsed.data.ref,
      periodEnd: new Date(parsed.data.periodEnd),
      platform: parsed.data.platform ?? null,
      eventAt: new Date(),
    });
  }

  parseEvent(raw: unknown): NormalizedProviderEvent {
    const parsed = testEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SubscriptionProviderError(
        `Not a test provider event: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
      );
    }
    const event = parsed.data;
    if ((event.kind === "started" || event.kind === "renewed") && !event.periodEnd) {
      throw new SubscriptionProviderError(`${event.kind} needs the end of the paid term`);
    }
    if ((event.kind === "grace_started" || event.kind === "payment_failed") && !event.graceUntil) {
      throw new SubscriptionProviderError(`${event.kind} needs the end of the grace`);
    }
    return {
      providerEventId: event.id,
      kind: event.kind,
      providerRef: event.ref,
      accountId: event.accountId ?? null,
      eventAt: new Date(event.at),
      periodEnd: event.periodEnd ? new Date(event.periodEnd) : null,
      graceUntil: event.graceUntil ? new Date(event.graceUntil) : null,
      platform: event.platform ?? null,
    };
  }
}
