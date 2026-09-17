import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientInfo, SignInStep } from "@adclub/contracts";
import { APP_CONFIG, type AppConfig } from "../../../config";
import type { DbExecutor } from "../../../database";
import type { SignInStepKind } from "../schema";
import { signInStepInvalidException } from "./session-errors";
import { signInStepKey } from "./session-tokens";
import type { SignInStepBinding } from "./sign-in-step-cookie";
import {
  hashSignInStepBinding,
  hashSignInStepSecret,
  newSignInStepBinding,
  newSignInStepToken,
  parseSignInStepToken,
  signInStepBindingMatches,
  signInStepSecretMatches,
} from "./sign-in-step-token";
import { SignInStepStore, type SignInStepRow } from "./sign-in-step.store";

export interface NewStepInput {
  kind: SignInStepKind;
  accountId: string;
  adminUserId: string | null;
  loginChallengeId: string;
  client: ClientInfo | null;
  deviceName: string | null;
  ip: string | null;
  ttlSeconds: number;
}

/**
 * Unfinished sign-ins (ARCHITECTURE 8.1): created in the transaction that
 * spends the login code, finished once, within their lifetime, and only
 * by the client that passed the code: the token from the response body
 * and the binding value from that client's step cookie are both needed.
 */
@Injectable()
export class SignInStepsService {
  private readonly logger = new Logger("SignIn");
  private readonly key: Buffer;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SignInStepStore) private readonly store: SignInStepStore,
  ) {
    this.key = signInStepKey(config.session.tokenSecret);
  }

  async create(
    input: NewStepInput,
    tx: DbExecutor,
  ): Promise<{ id: string; step: SignInStep; binding: SignInStepBinding }> {
    const id = randomUUID();
    const { token, secret } = newSignInStepToken(id);
    const binding = newSignInStepBinding();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    await this.store.create(
      {
        id,
        kind: input.kind,
        accountId: input.accountId,
        adminUserId: input.adminUserId,
        tokenHash: hashSignInStepSecret(this.key, id, secret),
        clientBindingHash: hashSignInStepBinding(this.key, id, binding),
        loginChallengeId: input.loginChallengeId,
        clientPlatform: input.client?.platform ?? null,
        clientVersion: input.client?.version ?? null,
        deviceName: input.deviceName,
        ip: input.ip,
        now,
        expiresAt,
      },
      tx,
    );
    return {
      id,
      step: { token, expiresAt: expiresAt.toISOString() },
      binding: { stepId: id, value: binding, expiresAt },
    };
  }

  /**
   * Locks the step the token names, or refuses: unknown or forged token,
   * another client (no or another step cookie), another kind of step,
   * used, or expired all answer `SIGN_IN_STEP_INVALID` (the reason goes to
   * the log only). A refusal changes nothing: the client that owns the
   * step can still finish it.
   */
  async open(
    token: string,
    binding: string | undefined,
    kinds: readonly SignInStepKind[],
    now: Date,
    tx: DbExecutor,
  ): Promise<SignInStepRow> {
    const parsed = parseSignInStepToken(token);
    const row = parsed ? await this.store.lock(parsed.stepId, tx) : undefined;
    const reason = !parsed
      ? "malformed_token"
      : !row || !signInStepSecretMatches(this.key, row.id, parsed.secret, row.tokenHash)
        ? "unknown_step"
        : !signInStepBindingMatches(this.key, row.id, binding, row.clientBindingHash)
          ? "other_client"
          : !kinds.includes(row.kind)
            ? "wrong_step"
            : row.consumedAt
              ? "already_used"
              : row.expiresAt.getTime() <= now.getTime()
                ? "expired"
                : null;
    if (reason !== null || !row) {
      this.logger.warn(
        `Sign-in step refused${parsed ? ` step=${parsed.stepId}` : ""} reason=${reason ?? "unknown_step"}`,
      );
      throw signInStepInvalidException();
    }
    return row;
  }

  consume(stepId: string, now: Date, tx: DbExecutor): Promise<void> {
    return this.store.consume(stepId, now, tx);
  }

  setTotpSecret(stepId: string, sealed: string, now: Date, tx: DbExecutor): Promise<void> {
    return this.store.setTotpSecret(stepId, sealed, now, tx);
  }

  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.store.transaction(work);
  }
}
