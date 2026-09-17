import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AdministratorListResponse,
  BackupCodesResponse,
  RateLimitName,
  TotpResetResponse,
  TotpSetupCompletedResponse,
  TotpSetupResponse,
  TotpVerifiedResponse,
} from "@adclub/contracts";
import { maskPhone } from "@adclub/domain";
import {
  ApiException,
  rateLimitedException,
  serviceUnavailableException,
} from "../../../common/errors";
import { APP_CONFIG, type AppConfig, type RateLimitSettings } from "../../../config";
import type { DbExecutor } from "../../../database";
import { RateLimiterService, RateLimiterUnavailableError } from "../../../redis";
import { AccountStore } from "../account/account.store";
import { rateLimitSubject } from "../login-code/rate-limit-subject";
import {
  notAdminException,
  signInStepInvalidException,
  totpInvalidException,
} from "../session/session-errors";
import { SessionService, type IssuedSession } from "../session/session.service";
import { SignInSettingsSource } from "../session/sign-in-settings.source";
import { SignInStepsService } from "../session/sign-in-steps.service";
import { clientOfStep } from "../session/sign-in.service";
import type { SignInStepRow } from "../session/sign-in-step.store";
import { AdminAccessRevoker } from "./admin-access-revoker";
import {
  deriveAdminKeys,
  generateBackupCode,
  hashBackupCode,
  normalizeBackupCode,
  openSecret,
  sealSecret,
  type AdminKeys,
} from "./admin-crypto";
import { AdminUserStore, type LockedAdmin } from "./admin-user.store";
import { generateTotpSecret, matchTotp, TOTP_DIGITS, TOTP_PERIOD_SECONDS, totpUri } from "./totp";

/** Shown as the issuer in the authenticator app (D-048). */
export const TOTP_ISSUER = "Asia Drive Club";

export type SecondFactor = { kind: "totp"; code: string } | { kind: "backup_code"; code: string };

export interface CompletedAdminSignIn<Response> {
  response: Response;
  issued: IssuedSession;
}

const rateLimitKeys = {
  perAdmin: (adminId: string) => `admin-totp:admin:${adminId}`,
  perIp: (subject: string) => `admin-totp:ip:${subject}`,
};

/** A refusal decided inside a transaction that must still commit (the step is spent). */
class CommittedRefusal {
  constructor(readonly error: ApiException) {}
}

/**
 * The administrator's second factor (ARCHITECTURE 8.1; D-047): setting up
 * the authenticator app on the first sign-in, checking the code or a
 * backup code on every sign-in, new backup codes, and resets. Secrets and
 * codes never reach the log; the TOTP secret is stored encrypted and
 * backup codes only as keyed hashes. Every decision runs under a lock of
 * the step and of the administrator row, so two tabs or a replayed code
 * can't both succeed.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger("AdminAuth");
  private readonly keys: AdminKeys;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SignInSettingsSource) private readonly settingsSource: SignInSettingsSource,
    @Inject(SignInStepsService) private readonly steps: SignInStepsService,
    @Inject(AdminUserStore) private readonly admins: AdminUserStore,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AdminAccessRevoker) private readonly revoker: AdminAccessRevoker,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {
    this.keys = deriveAdminKeys(config.signIn.totpEncryptionKey);
  }

  /**
   * The authenticator app data of a setup step. The secret is created
   * once per step (kept encrypted in the step) and repeated on a retry.
   */
  async startSetup(token: string, stepBinding: string | undefined): Promise<TotpSetupResponse> {
    const now = new Date();
    return this.inTransaction(async (tx) => {
      const { step, admin } = await this.openAdminStep(
        token,
        stepBinding,
        "admin_totp_setup",
        now,
        tx,
      );
      let secret: string;
      if (step.totpSecret) {
        secret = openSecret(this.keys.encryption, step.id, step.totpSecret);
      } else {
        secret = generateTotpSecret();
        await this.steps.setTotpSecret(
          step.id,
          sealSecret(this.keys.encryption, step.id, secret),
          now,
          tx,
        );
        this.logger.log(`Admin TOTP setup started admin=${admin.id} step=${step.id}`);
      }
      const account = await this.accounts.findById(admin.accountId, tx);
      const accountName = maskPhone(account.phone);
      return {
        otpauthUri: totpUri(secret, TOTP_ISSUER, accountName),
        secret,
        issuer: TOTP_ISSUER,
        accountName,
        digits: TOTP_DIGITS,
        periodSeconds: TOTP_PERIOD_SECONDS,
        algorithm: "SHA1",
      };
    });
  }

  /** Confirms the app with its current code: the admin session and the backup codes. */
  async confirmSetup(input: {
    token: string;
    stepBinding: string | undefined;
    totpCode: string;
    deviceName: string | null;
    ip: string | null;
  }): Promise<CompletedAdminSignIn<TotpSetupCompletedResponse>> {
    const settings = await this.settingsSource.getSettings();
    await this.limit(
      rateLimitKeys.perIp(rateLimitSubject(input.ip ?? undefined)),
      settings.totpVerifyPerIp,
      "admin_totp_per_ip",
      "-",
    );
    const now = new Date();
    return this.inTransaction(async (tx) => {
      const { step, admin } = await this.openAdminStep(
        input.token,
        input.stepBinding,
        "admin_totp_setup",
        now,
        tx,
      );
      if (!step.totpSecret) {
        throw new ApiException(409, "CONFLICT", "Start the authenticator setup first");
      }
      await this.limit(
        rateLimitKeys.perAdmin(admin.id),
        settings.totpVerifyPerAdmin,
        "admin_totp_per_admin",
        admin.id,
      );
      const secret = openSecret(this.keys.encryption, step.id, step.totpSecret);
      const matched = matchTotp(
        secret,
        input.totpCode,
        now.getTime(),
        settings.totpAllowedDriftSteps,
        null,
      );
      if (matched === null) {
        this.logger.warn(
          `Admin TOTP setup failed admin=${admin.id} step=${step.id} reason=wrong_code`,
        );
        throw totpInvalidException();
      }
      await this.admins.setTotp(
        admin.id,
        sealSecret(this.keys.encryption, admin.id, secret),
        matched,
        now,
        tx,
      );
      const backupCodes = await this.newBackupCodes(admin.id, settings.backupCodeCount, now, tx);
      const issued = await this.finish(step, admin, input, now, tx);
      this.logger.log(
        `Admin TOTP set up admin=${admin.id} backupCodes=${backupCodes.length} session=${issued.tokens.sessionId} step=${step.id}`,
      );
      return {
        response: {
          status: "signed_in",
          accountId: admin.accountId,
          session: issued.tokens,
          access: { context: "admin", admin: { id: admin.id } },
          backupCodes,
        },
        issued,
      };
    });
  }

  /** Every later sign-in: the app's code or an unused backup code. */
  async verify(input: {
    token: string;
    stepBinding: string | undefined;
    factor: SecondFactor;
    deviceName: string | null;
    ip: string | null;
  }): Promise<CompletedAdminSignIn<TotpVerifiedResponse>> {
    const settings = await this.settingsSource.getSettings();
    await this.limit(
      rateLimitKeys.perIp(rateLimitSubject(input.ip ?? undefined)),
      settings.totpVerifyPerIp,
      "admin_totp_per_ip",
      "-",
    );
    const now = new Date();
    return this.inTransaction(async (tx) => {
      const { step, admin } = await this.openAdminStep(
        input.token,
        input.stepBinding,
        "admin_totp",
        now,
        tx,
      );
      await this.limit(
        rateLimitKeys.perAdmin(admin.id),
        settings.totpVerifyPerAdmin,
        "admin_totp_per_admin",
        admin.id,
      );
      await this.checkFactor(
        admin,
        input.factor,
        settings.totpAllowedDriftSteps,
        now,
        tx,
        `step=${step.id}`,
      );
      const backupCodesRemaining = await this.admins.countUnusedBackupCodes(admin.id, tx);
      const issued = await this.finish(step, admin, input, now, tx);
      this.logger.log(
        `Admin sign-in completed admin=${admin.id} method=${input.factor.kind} session=${issued.tokens.sessionId} step=${step.id}`,
      );
      return {
        response: {
          status: "signed_in",
          accountId: admin.accountId,
          session: issued.tokens,
          access: { context: "admin", admin: { id: admin.id } },
          backupCodesRemaining,
        },
        issued,
      };
    });
  }

  /** A new set of backup codes for the signed-in administrator; the app's code confirms it. */
  async regenerateBackupCodes(input: {
    adminId: string;
    totpCode: string;
    ip: string | null;
  }): Promise<BackupCodesResponse> {
    const settings = await this.settingsSource.getSettings();
    await this.limit(
      rateLimitKeys.perIp(rateLimitSubject(input.ip ?? undefined)),
      settings.totpVerifyPerIp,
      "admin_totp_per_ip",
      "-",
    );
    const now = new Date();
    return this.inTransaction(async (tx) => {
      const admin = await this.admins.lock(input.adminId, tx);
      if (!admin || admin.status !== "active" || !admin.totpSecret) {
        // The access rule let this session in a moment ago; it changed since.
        throw new ApiException(403, "FORBIDDEN", "This session can't use this route");
      }
      await this.limit(
        rateLimitKeys.perAdmin(admin.id),
        settings.totpVerifyPerAdmin,
        "admin_totp_per_admin",
        admin.id,
      );
      await this.checkFactor(
        admin,
        { kind: "totp", code: input.totpCode },
        settings.totpAllowedDriftSteps,
        now,
        tx,
        "purpose=backup_codes",
      );
      const backupCodes = await this.newBackupCodes(admin.id, settings.backupCodeCount, now, tx);
      this.logger.log(
        `Admin backup codes regenerated admin=${admin.id} count=${backupCodes.length}`,
      );
      return { backupCodes };
    });
  }

  async listAdministrators(currentAdminId: string): Promise<AdministratorListResponse> {
    const rows = await this.admins.listActive();
    return {
      administrators: rows.map((row) => ({
        id: row.id,
        phoneMasked: maskPhone(row.phone),
        totpConfigured: row.totpConfigured,
        current: row.id === currentAdminId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Another administrator's reset (D-047): their secret and backup codes
   * stop working, their admin sessions end, setup is due at their next
   * sign-in. Resetting oneself is refused. Any id that isn't an active
   * administrator is `NOT_FOUND`.
   */
  async resetByAdmin(actorAdminId: string, targetAdminId: string): Promise<TotpResetResponse> {
    if (actorAdminId === targetAdminId) {
      this.logger.warn(`Admin TOTP reset refused: own second factor admin=${actorAdminId}`);
      throw new ApiException(
        403,
        "TOTP_SELF_RESET_FORBIDDEN",
        "Another administrator has to reset your second factor",
      );
    }
    const sessionsEnded = await this.inTransaction(async (tx) => {
      const target = await this.admins.lock(targetAdminId, tx);
      if (!target || target.status !== "active") {
        this.logger.warn(
          `Admin TOTP reset refused: no such administrator admin=${targetAdminId} by=${actorAdminId}`,
        );
        throw new ApiException(404, "NOT_FOUND", "Administrator not found");
      }
      return this.revoker.resetTotp(target, new Date(), tx);
    });
    this.logger.log(
      `Admin TOTP reset admin=${targetAdminId} by=admin:${actorAdminId} sessionsEnded=${sessionsEnded}`,
    );
    return { sessionsEnded };
  }

  private async checkFactor(
    admin: LockedAdmin,
    factor: SecondFactor,
    driftSteps: number,
    now: Date,
    tx: DbExecutor,
    label: string,
  ): Promise<void> {
    if (factor.kind === "totp") {
      const secret = openSecret(this.keys.encryption, admin.id, admin.totpSecret!);
      const matched = matchTotp(
        secret,
        factor.code,
        now.getTime(),
        driftSteps,
        admin.totpLastUsedStep,
      );
      if (matched === null) {
        this.logger.warn(`Admin second factor failed admin=${admin.id} method=totp ${label}`);
        throw totpInvalidException();
      }
      await this.admins.recordTotpStep(admin.id, matched, now, tx);
      this.logger.log(`Admin second factor passed admin=${admin.id} method=totp ${label}`);
      return;
    }
    const normalized = normalizeBackupCode(factor.code);
    const used =
      normalized !== null &&
      (await this.admins.useBackupCode(
        admin.id,
        hashBackupCode(this.keys.backupCodes, admin.id, normalized),
        now,
        tx,
      ));
    if (!used) {
      this.logger.warn(`Admin second factor failed admin=${admin.id} method=backup_code ${label}`);
      throw totpInvalidException();
    }
    const remaining = await this.admins.countUnusedBackupCodes(admin.id, tx);
    this.logger.log(`Admin backup code used admin=${admin.id} remaining=${remaining} ${label}`);
  }

  /**
   * Locks the step and its administrator. A removed administrator, or a
   * second factor that changed since the step began (reset, or set up in
   * another tab), spends the step and refuses.
   */
  private async openAdminStep(
    token: string,
    stepBinding: string | undefined,
    kind: "admin_totp_setup" | "admin_totp",
    now: Date,
    tx: DbExecutor,
  ): Promise<{ step: SignInStepRow; admin: LockedAdmin }> {
    const step = await this.steps.open(token, stepBinding, [kind], now, tx);
    const admin = step.adminUserId ? await this.admins.lock(step.adminUserId, tx) : undefined;
    if (!admin || admin.status !== "active") {
      await this.steps.consume(step.id, now, tx);
      this.logger.warn(
        `Admin sign-in refused: not an administrator any more admin=${step.adminUserId} step=${step.id}`,
      );
      throw new CommittedRefusal(notAdminException());
    }
    const configured = admin.totpSecret !== null;
    if (configured !== (kind === "admin_totp")) {
      await this.steps.consume(step.id, now, tx);
      this.logger.warn(
        `Sign-in step refused step=${step.id} admin=${admin.id} reason=${configured ? "totp_already_set_up" : "totp_reset"}`,
      );
      throw new CommittedRefusal(signInStepInvalidException());
    }
    return { step, admin };
  }

  private async finish(
    step: SignInStepRow,
    admin: LockedAdmin,
    input: { deviceName: string | null; ip: string | null },
    now: Date,
    tx: DbExecutor,
  ): Promise<IssuedSession> {
    await this.steps.consume(step.id, now, tx);
    const account = await this.accounts.findById(admin.accountId, tx);
    return this.sessions.issue(
      {
        account,
        kind: "admin_web",
        client: clientOfStep(step),
        deviceName: input.deviceName ?? step.deviceName,
        ip: input.ip,
        loginChallengeId: step.loginChallengeId,
      },
      tx,
    );
  }

  private async newBackupCodes(
    adminId: string,
    count: number,
    now: Date,
    tx: DbExecutor,
  ): Promise<string[]> {
    const codes = new Set<string>();
    while (codes.size < count) {
      codes.add(generateBackupCode());
    }
    const list = [...codes];
    await this.admins.replaceBackupCodes(
      adminId,
      list.map((code) =>
        hashBackupCode(this.keys.backupCodes, adminId, normalizeBackupCode(code)!),
      ),
      now,
      tx,
    );
    return list;
  }

  /**
   * Runs `work` in one transaction. A `CommittedRefusal` commits what was
   * done (the spent step) and is then thrown as its error; any other
   * error rolls everything back.
   */
  private async inTransaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const result = await this.steps.transaction(async (tx) => {
      try {
        return { value: await work(tx) };
      } catch (error) {
        if (error instanceof CommittedRefusal) {
          return { refusal: error.error };
        }
        throw error;
      }
    });
    if ("refusal" in result) {
      throw result.refusal;
    }
    return result.value;
  }

  /** Counts one second factor check; Redis down refuses instead of skipping the limit. */
  private async limit(
    key: string,
    limit: RateLimitSettings,
    name: RateLimitName,
    subject: string,
  ): Promise<void> {
    let hit;
    try {
      hit = await this.rateLimiter.hit(key, limit);
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        this.logger.warn(`Admin second factor refused: ${error.message}`);
        throw serviceUnavailableException();
      }
      throw error;
    }
    if (!hit.allowed) {
      this.logger.warn(`Admin second factor rate limit hit limit=${name} admin=${subject}`);
      throw rateLimitedException(name, hit.retryAfterSeconds);
    }
  }
}
