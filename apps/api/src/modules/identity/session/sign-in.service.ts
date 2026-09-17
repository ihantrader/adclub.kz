import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  clientPlatformSchema,
  type ClientInfo,
  type LoginCodeVerifiedResponse,
  type SessionAccess,
  type SessionKind,
  type SignInCompletedResponse,
  type SignInStep,
  type SupplierSelectionRequiredDetails,
  type SupplierSummary,
  type TotpStepRequiredDetails,
} from "@adclub/contracts";
import { maskPhone } from "@adclub/domain";
import type { RequestClient } from "../../../common/client";
import { ApiException } from "../../../common/errors";
import type { DbExecutor } from "../../../database";
import { AccountStore, type AccountRecord } from "../account/account.store";
import { AdminUserStore } from "../admin/admin-user.store";
import { LoginCodeService } from "../login-code/login-code.service";
import {
  SupplierMembershipStore,
  type ActiveMembership,
} from "../supplier/supplier-membership.store";
import { notAdminException, notSupplierMemberException } from "./session-errors";
import { SessionService, type IssuedSession } from "./session.service";
import { SignInSettingsSource } from "./sign-in-settings.source";
import { SignInStepsService } from "./sign-in-steps.service";

export interface SignInInput {
  phone: string;
  code: string;
  deviceName: string | null;
  /** Supplier cabinet: the company chosen last time, if the client remembers one. */
  supplierId: string | null;
  client: RequestClient;
  ip: string | null;
}

export interface SelectSupplierInput {
  signInStep: string;
  supplierId: string;
  deviceName: string | null;
  ip: string | null;
}

/** A finished sign-in: what the client gets and the tokens (the refresh one goes to a cookie on the web). */
export interface CompletedSignIn<Response> {
  response: Response;
  issued: IssuedSession;
}

/** The session kind a client signs in for: the platform in `X-Client` decides. */
export function sessionKindForClient(client: RequestClient): SessionKind {
  if (client.kind !== "known") {
    // A caller that doesn't identify itself gets the least privileged kind.
    return "mobile";
  }
  switch (client.client.platform) {
    case "ios":
    case "android":
      return "mobile";
    case "supplier-web":
      return "supplier_web";
    case "admin-web":
      return "admin_web";
  }
}

function supplierAccess(membership: ActiveMembership): SessionAccess {
  return {
    context: "supplier",
    supplier: membership.supplier,
    member: { id: membership.memberId, displayName: membership.displayName },
  };
}

/** What happened in the transaction that spent the login code. */
type CodeOutcome =
  | {
      kind: "signed_in";
      account: AccountRecord & { created?: boolean };
      issued: IssuedSession;
      access: SessionAccess;
    }
  | { kind: "refused"; error: () => ApiException; log: string }
  | { kind: "step"; error: ApiException; log: string };

/**
 * Sign-in by one-time code (ARCHITECTURE 8.1, 8.2; D-025, D-046). The code
 * is always checked and spent first; what follows depends on the client:
 * - the mobile app: the account is found or created and a session issued;
 * - the supplier cabinet: only for an active employee — one company, or
 *   the remembered one, gives a session at once; several open a company
 *   choice; none is a refusal;
 * - the admin panel: only for an active administrator, and never a
 *   session yet — the second factor step opens (setup on first sign-in).
 * Refusals create no account and no session, and are only told after
 * the code, so nobody learns whose number is linked without owning it.
 */
@Injectable()
export class SignInService {
  private readonly logger = new Logger("SignIn");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(LoginCodeService) private readonly loginCodes: LoginCodeService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SupplierMembershipStore) private readonly memberships: SupplierMembershipStore,
    @Inject(AdminUserStore) private readonly admins: AdminUserStore,
    @Inject(SignInStepsService) private readonly steps: SignInStepsService,
    @Inject(SignInSettingsSource) private readonly settingsSource: SignInSettingsSource,
  ) {}

  async signIn(input: SignInInput): Promise<CompletedSignIn<LoginCodeVerifiedResponse>> {
    const kind = sessionKindForClient(input.client);
    const client = input.client.kind === "known" ? input.client.client : null;
    const settings = await this.settingsSource.getSettings();

    const { verified, completed } = await this.loginCodes.verifyCodeAnd<CodeOutcome>(
      { phone: input.phone, code: input.code },
      async (confirmed, tx) => {
        const base = {
          client,
          deviceName: input.deviceName,
          ip: input.ip,
          loginChallengeId: confirmed.challengeId,
        };
        const masked = maskPhone(confirmed.phone);
        switch (kind) {
          case "mobile": {
            const account = await this.accounts.findOrCreateByPhone(confirmed.phone, tx);
            const issued = await this.sessions.issue({ ...base, account, kind }, tx);
            return { kind: "signed_in", account, issued, access: { context: "user" } };
          }
          case "supplier_web": {
            const account = await this.accounts.findByPhone(confirmed.phone, tx);
            const memberships = account ? await this.memberships.listActive(account.id, tx) : [];
            if (!account || memberships.length === 0) {
              return {
                kind: "refused",
                error: notSupplierMemberException,
                log: `Supplier sign-in refused: no active membership phone=${masked}`,
              };
            }
            const chosen =
              memberships.length === 1
                ? memberships[0]
                : memberships.find((membership) => membership.supplier.id === input.supplierId);
            if (chosen) {
              const issued = await this.issueSupplierSession(account, chosen, base, tx);
              return { kind: "signed_in", account, issued, access: supplierAccess(chosen) };
            }
            const { id, step } = await this.steps.create(
              {
                ...base,
                kind: "supplier_selection",
                accountId: account.id,
                adminUserId: null,
                ttlSeconds: settings.supplierSelectionTtlSeconds,
              },
              tx,
            );
            const details: SupplierSelectionRequiredDetails = {
              signInStep: step,
              suppliers: memberships.map((membership): SupplierSummary => membership.supplier),
            };
            return {
              kind: "step",
              error: new ApiException(
                403,
                "SUPPLIER_SELECTION_REQUIRED",
                "Choose the company to sign in to",
                { details },
              ),
              log: `Supplier sign-in: company choice required account=${account.id} companies=${memberships.length} step=${id} phone=${masked}`,
            };
          }
          case "admin_web": {
            const account = await this.accounts.findByPhone(confirmed.phone, tx);
            const admin = account
              ? await this.admins.findActiveByAccount(account.id, tx)
              : undefined;
            if (!account || !admin) {
              return {
                kind: "refused",
                error: notAdminException,
                log: `Admin sign-in refused: not an administrator phone=${masked}`,
              };
            }
            const setup = !admin.totpConfigured;
            const { id, step } = await this.steps.create(
              {
                ...base,
                kind: setup ? "admin_totp_setup" : "admin_totp",
                accountId: account.id,
                adminUserId: admin.id,
                ttlSeconds: settings.adminTotpTtlSeconds,
              },
              tx,
            );
            return {
              kind: "step",
              error: totpStepRequired(setup, step),
              log: `Admin sign-in: second factor ${setup ? "setup" : "check"} required admin=${admin.id} account=${account.id} step=${id} phone=${masked}`,
            };
          }
        }
      },
    );

    // The code is spent (committed) whatever happens below.
    switch (completed.kind) {
      case "refused":
        this.logger.warn(completed.log);
        throw completed.error();
      case "step":
        this.logger.log(completed.log);
        throw completed.error;
      case "signed_in":
        if (completed.account.created) {
          this.logger.log(`Account created account=${completed.account.id}`);
        }
        if (completed.access.context === "supplier") {
          this.logger.log(
            `Supplier sign-in completed account=${completed.account.id} supplier=${completed.access.supplier.id} member=${completed.access.member.id} session=${completed.issued.tokens.sessionId}`,
          );
        }
        return {
          response: {
            status: "verified",
            phone: verified.phone,
            accountId: completed.account.id,
            session: completed.issued.tokens,
            access: completed.access,
          },
          issued: completed.issued,
        };
    }
  }

  /** Finishes a company choice: only a company the number is still an active employee of. */
  async selectSupplier(
    input: SelectSupplierInput,
  ): Promise<CompletedSignIn<SignInCompletedResponse>> {
    const now = new Date();
    return this.steps
      .transaction(async (tx) => {
        const step = await this.steps.open(input.signInStep, ["supplier_selection"], now, tx);
        const memberships = await this.memberships.listActive(step.accountId, tx);
        if (memberships.length === 0) {
          // Every membership was removed meanwhile: nothing left to choose.
          await this.steps.consume(step.id, now, tx);
          this.logger.warn(
            `Supplier sign-in refused: no active membership left account=${step.accountId} step=${step.id}`,
          );
          return { refused: notSupplierMemberException() };
        }
        const chosen = memberships.find(
          (membership) => membership.supplier.id === input.supplierId,
        );
        if (!chosen) {
          // The step stays usable: another company can still be chosen.
          this.logger.warn(
            `Supplier sign-in: company not available account=${step.accountId} step=${step.id} supplier=${input.supplierId}`,
          );
          throw new ApiException(404, "NOT_FOUND", "Company not found");
        }
        const account = await this.accounts.findById(step.accountId, tx);
        await this.steps.consume(step.id, now, tx);
        const issued = await this.issueSupplierSession(
          account,
          chosen,
          {
            client: clientOfStep(step),
            deviceName: input.deviceName ?? step.deviceName,
            ip: input.ip,
            loginChallengeId: step.loginChallengeId,
          },
          tx,
        );
        this.logger.log(
          `Supplier sign-in completed with company choice account=${account.id} supplier=${chosen.supplier.id} member=${chosen.memberId} session=${issued.tokens.sessionId} step=${step.id}`,
        );
        return {
          completed: {
            response: {
              status: "signed_in" as const,
              accountId: account.id,
              session: issued.tokens,
              access: supplierAccess(chosen),
            },
            issued,
          },
        };
      })
      .then((result) => {
        if ("refused" in result) {
          throw result.refused;
        }
        return result.completed;
      });
  }

  private issueSupplierSession(
    account: { id: string; phone: string },
    membership: ActiveMembership,
    base: {
      client: ClientInfo | null;
      deviceName: string | null;
      ip: string | null;
      loginChallengeId: string | null;
    },
    tx: DbExecutor,
  ): Promise<IssuedSession> {
    return this.sessions.issue(
      {
        ...base,
        account,
        kind: "supplier_web",
        context: { supplierId: membership.supplier.id, supplierMemberId: membership.memberId },
      },
      tx,
    );
  }
}

export function totpStepRequired(setup: boolean, step: SignInStep): ApiException {
  const details: TotpStepRequiredDetails = { signInStep: step };
  return setup
    ? new ApiException(403, "TOTP_SETUP_REQUIRED", "Set up the authenticator app", { details })
    : new ApiException(403, "TOTP_REQUIRED", "Enter the code from the authenticator app", {
        details,
      });
}

/** The client recorded when the step was created (the session is for that client). */
export function clientOfStep(step: {
  clientPlatform: string | null;
  clientVersion: string | null;
}): ClientInfo | null {
  const platform = clientPlatformSchema.safeParse(step.clientPlatform);
  return platform.success && step.clientVersion
    ? { platform: platform.data, version: step.clientVersion }
    : null;
}
