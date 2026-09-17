import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoginCodeVerifiedResponse, SessionKind } from "@adclub/contracts";
import type { RequestClient } from "../../../common/client";
import { AccountStore } from "../account/account.store";
import { LoginCodeService } from "../login-code/login-code.service";
import { sessionKindUnavailableException } from "./session-errors";
import { SessionService, type IssuedSession } from "./session.service";

export interface SignInInput {
  phone: string;
  code: string;
  deviceName: string | null;
  client: RequestClient;
  ip: string | null;
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

/**
 * Sign-in by one-time code (ARCHITECTURE 8.1, 8.2; D-025): the code is
 * spent, the account for the number is found or created, and the session
 * is created — all in one transaction. Supplier cabinet and admin panel
 * sessions are refused before the code is even checked, until TASK-006
 * adds the membership and administrator checks.
 */
@Injectable()
export class SignInService {
  private readonly logger = new Logger("SignIn");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(LoginCodeService) private readonly loginCodes: LoginCodeService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async signIn(
    input: SignInInput,
  ): Promise<{ response: LoginCodeVerifiedResponse; issued: IssuedSession }> {
    const kind = sessionKindForClient(input.client);
    if (kind !== "mobile") {
      this.logger.warn(`Sign-in refused: session kind not available kind=${kind}`);
      throw sessionKindUnavailableException();
    }

    const { verified, completed } = await this.loginCodes.verifyCodeAnd(
      { phone: input.phone, code: input.code },
      async (confirmed, tx) => {
        const account = await this.accounts.findOrCreateByPhone(confirmed.phone, tx);
        const issued = await this.sessions.issue(
          {
            account,
            kind,
            client: input.client.kind === "known" ? input.client.client : null,
            deviceName: input.deviceName,
            ip: input.ip,
            loginChallengeId: confirmed.challengeId,
          },
          tx,
        );
        return { account, issued };
      },
    );
    if (completed.account.created) {
      this.logger.log(`Account created account=${completed.account.id}`);
    }
    return {
      response: {
        status: "verified",
        phone: verified.phone,
        accountId: completed.account.id,
        session: completed.issued.tokens,
      },
      issued: completed.issued,
    };
  }
}
