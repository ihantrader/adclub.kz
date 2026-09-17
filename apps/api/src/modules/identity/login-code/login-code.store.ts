import { Inject, Injectable } from "@nestjs/common";
import type { LoginCodeChannel } from "@adclub/contracts";
import { and, eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { otpChallenge, phoneVerification } from "../schema";

const PURPOSE = "login";

export interface NewChallenge {
  id: string;
  phone: string;
  codeHash: string;
  maxAttempts: number;
  expiresAt: Date;
}

export interface ActiveChallenge {
  id: string;
  codeHash: string;
  channel: LoginCodeChannel;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  nextAttemptAt: Date | null;
}

/**
 * What to do with the active challenge after looking at it (decided by the
 * service, applied atomically by `attemptVerification`).
 */
export type VerificationDecision =
  | { kind: "consume" }
  | { kind: "expire" }
  | { kind: "fail"; nextAttemptAt: Date | null; exhausted: boolean };

/**
 * Persistence of login codes (`otp_challenge`, `phone_verification`).
 * Every state change that races with another request runs in a
 * transaction under a row lock or a per-phone advisory lock.
 */
@Injectable()
export class LoginCodeStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async createPending(challenge: NewChallenge): Promise<void> {
    await this.database.db.insert(otpChallenge).values({
      id: challenge.id,
      phone: challenge.phone,
      purpose: PURPOSE,
      status: "pending",
      codeHash: challenge.codeHash,
      maxAttempts: challenge.maxAttempts,
      expiresAt: challenge.expiresAt,
    });
  }

  /**
   * The delivered code becomes the only one the phone accepts: any other
   * active code is superseded in the same transaction. Serialized per
   * phone, so concurrent requests always leave exactly one active code —
   * the one delivered last.
   */
  async activate(
    id: string,
    phone: string,
    channel: LoginCodeChannel,
    now: Date,
    expiresAt: Date,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`otp:${phone}`}, 0))`);
      await tx
        .update(otpChallenge)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(otpChallenge.phone, phone),
            eq(otpChallenge.purpose, PURPOSE),
            eq(otpChallenge.status, "active"),
          ),
        );
      const activated = await tx
        .update(otpChallenge)
        .set({ status: "active", channel, deliveredAt: now, expiresAt, updatedAt: now })
        .where(and(eq(otpChallenge.id, id), eq(otpChallenge.status, "pending")))
        .returning({ id: otpChallenge.id });
      if (activated.length !== 1) {
        throw new Error(`Login code challenge ${id} is no longer pending`);
      }
    });
  }

  async markFailed(id: string, now: Date): Promise<void> {
    await this.database.db
      .update(otpChallenge)
      .set({ status: "failed", updatedAt: now })
      .where(and(eq(otpChallenge.id, id), eq(otpChallenge.status, "pending")));
  }

  /**
   * Locks the phone's active challenge (if any), lets `decide` look at it,
   * and applies the decision in the same transaction — two concurrent
   * entries of the right code can't both succeed. A consumed challenge
   * also records the confirming channel in `phone_verification`, then runs
   * `onConsumed` in the same transaction (sign-in creates the account and
   * the session there): if it fails, the code stays unspent.
   */
  async attemptVerification<T, U = undefined>(
    phone: string,
    now: Date,
    decide: (challenge: ActiveChallenge | undefined) => {
      decision?: VerificationDecision;
      result: T;
    },
    onConsumed?: (tx: DbExecutor) => Promise<U>,
  ): Promise<{ result: T; consumed?: U }> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: otpChallenge.id,
          codeHash: otpChallenge.codeHash,
          channel: otpChallenge.channel,
          attempts: otpChallenge.attempts,
          maxAttempts: otpChallenge.maxAttempts,
          expiresAt: otpChallenge.expiresAt,
          nextAttemptAt: otpChallenge.nextAttemptAt,
        })
        .from(otpChallenge)
        .where(
          and(
            eq(otpChallenge.phone, phone),
            eq(otpChallenge.purpose, PURPOSE),
            eq(otpChallenge.status, "active"),
          ),
        )
        .for("update");

      const challenge =
        row && row.channel ? ({ ...row, channel: row.channel } as ActiveChallenge) : undefined;
      const { decision, result } = decide(challenge);
      if (!challenge || !decision) {
        return { result };
      }

      switch (decision.kind) {
        case "consume":
          await tx
            .update(otpChallenge)
            .set({ status: "consumed", consumedAt: now, updatedAt: now })
            .where(eq(otpChallenge.id, challenge.id));
          await tx
            .insert(phoneVerification)
            .values({ phone, channel: challenge.channel, verifiedAt: now })
            .onConflictDoUpdate({
              target: phoneVerification.phone,
              set: { channel: challenge.channel, verifiedAt: now, updatedAt: now },
            });
          if (onConsumed) {
            return { result, consumed: await onConsumed(tx) };
          }
          break;
        case "expire":
          await tx
            .update(otpChallenge)
            .set({ status: "expired", updatedAt: now })
            .where(eq(otpChallenge.id, challenge.id));
          break;
        case "fail":
          await tx
            .update(otpChallenge)
            .set({
              attempts: sql`${otpChallenge.attempts} + 1`,
              nextAttemptAt: decision.nextAttemptAt,
              status: decision.exhausted ? "exhausted" : "active",
              updatedAt: now,
            })
            .where(eq(otpChallenge.id, challenge.id));
          break;
      }
      return { result };
    });
  }
}
