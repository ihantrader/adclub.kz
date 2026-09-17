import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { signInStep, type SignInStepKind } from "../schema";

export interface NewSignInStep {
  id: string;
  kind: SignInStepKind;
  accountId: string;
  adminUserId: string | null;
  tokenHash: string;
  clientBindingHash: string;
  loginChallengeId: string | null;
  clientPlatform: string | null;
  clientVersion: string | null;
  deviceName: string | null;
  ip: string | null;
  now: Date;
  expiresAt: Date;
}

export interface SignInStepRow {
  id: string;
  kind: SignInStepKind;
  accountId: string;
  adminUserId: string | null;
  tokenHash: string;
  clientBindingHash: string | null;
  totpSecret: string | null;
  loginChallengeId: string | null;
  clientPlatform: string | null;
  clientVersion: string | null;
  deviceName: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

const columns = {
  id: signInStep.id,
  kind: signInStep.kind,
  accountId: signInStep.accountId,
  adminUserId: signInStep.adminUserId,
  tokenHash: signInStep.tokenHash,
  clientBindingHash: signInStep.clientBindingHash,
  totpSecret: signInStep.totpSecret,
  loginChallengeId: signInStep.loginChallengeId,
  clientPlatform: signInStep.clientPlatform,
  clientVersion: signInStep.clientVersion,
  deviceName: signInStep.deviceName,
  expiresAt: signInStep.expiresAt,
  consumedAt: signInStep.consumedAt,
};

/** Persistence of unfinished sign-ins (`sign_in_step`). */
@Injectable()
export class SignInStepStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async create(step: NewSignInStep, executor: DbExecutor): Promise<void> {
    await executor.insert(signInStep).values({
      id: step.id,
      kind: step.kind,
      accountId: step.accountId,
      adminUserId: step.adminUserId,
      tokenHash: step.tokenHash,
      clientBindingHash: step.clientBindingHash,
      loginChallengeId: step.loginChallengeId,
      clientPlatform: step.clientPlatform,
      clientVersion: step.clientVersion,
      deviceName: step.deviceName,
      ip: step.ip,
      expiresAt: step.expiresAt,
      createdAt: step.now,
      updatedAt: step.now,
    });
  }

  /** Locks the step: concurrent attempts to finish it are serialized. */
  async lock(stepId: string, tx: DbExecutor): Promise<SignInStepRow | undefined> {
    const [row] = await tx
      .select(columns)
      .from(signInStep)
      .where(eq(signInStep.id, stepId))
      .for("update");
    return row;
  }

  async consume(stepId: string, now: Date, tx: DbExecutor): Promise<void> {
    await tx
      .update(signInStep)
      .set({ consumedAt: now, updatedAt: now })
      .where(and(eq(signInStep.id, stepId), isNull(signInStep.consumedAt)));
  }

  async setTotpSecret(stepId: string, sealed: string, now: Date, tx: DbExecutor): Promise<void> {
    await tx
      .update(signInStep)
      .set({ totpSecret: sealed, updatedAt: now })
      .where(eq(signInStep.id, stepId));
  }

  /** Runs `work` in a transaction (store methods above take its executor). */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.database.db.transaction(work);
  }
}
