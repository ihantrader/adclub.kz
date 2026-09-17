import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskPhone, normalizeKzMobilePhone } from "@adclub/domain";
import { APP_CONFIG, type AppConfig } from "../../../config";
import { DatabaseService } from "../../../database";
import { AccountStore } from "../account/account.store";
import { SessionStore } from "../session/session.store";
import { SupplierMembershipStore } from "../supplier/supplier-membership.store";
import { AdminAccessRevoker } from "./admin-access-revoker";
import { AdminUserStore } from "./admin-user.store";

export class OperatorCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorCommandError";
  }
}

function normalizedPhone(input: string): string {
  const phone = normalizeKzMobilePhone(input);
  if (!phone) {
    throw new OperatorCommandError("Not a Kazakhstan mobile number (+7 7xx xxx xx xx)");
  }
  return phone;
}

/**
 * What only the server operator may do (D-045): appoint and remove
 * administrators, reset a second factor (the only way for the only
 * administrator, D-047) — and, in development and tests only, create
 * companies and employees (`cli/operator.ts`). There is no API for any
 * of it. Every action is written to the application log (the action
 * journal `audit_log` arrives with TASK-009), phone numbers masked.
 */
@Injectable()
export class OperatorService {
  private readonly logger = new Logger("Operator");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    @Inject(AdminUserStore) private readonly admins: AdminUserStore,
    @Inject(AdminAccessRevoker) private readonly revoker: AdminAccessRevoker,
    @Inject(SupplierMembershipStore) private readonly memberships: SupplierMembershipStore,
    @Inject(SessionStore) private readonly sessions: SessionStore,
  ) {}

  /** Appoints the number (its account is created if it has none, D-046). */
  async grantAdmin(phoneInput: string): Promise<{ adminId: string; outcome: string }> {
    const phone = normalizedPhone(phoneInput);
    const result = await this.database.db.transaction(async (tx) => {
      const account = await this.accounts.findOrCreateByPhone(phone, tx);
      return { account, ...(await this.admins.grant(account.id, tx)) };
    });
    if (result.account.created) {
      this.logger.log(`Account created account=${result.account.id} by=operator`);
    }
    this.logger.log(
      `Operator: administrator appointed admin=${result.id} account=${result.account.id} phone=${maskPhone(phone)} outcome=${result.outcome}`,
    );
    return { adminId: result.id, outcome: result.outcome };
  }

  /** Removes the administrator: every admin session ends at once. */
  async revokeAdmin(phoneInput: string): Promise<{ adminId: string; sessionsEnded: number }> {
    const phone = normalizedPhone(phoneInput);
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const admin = await this.activeAdmin(phone, tx);
      return { admin, sessionsEnded: await this.revoker.remove(admin, now, tx) };
    });
    this.logger.log(
      `Operator: administrator removed admin=${result.admin.id} account=${result.admin.accountId} phone=${maskPhone(phone)} sessionsEnded=${result.sessionsEnded}`,
    );
    return { adminId: result.admin.id, sessionsEnded: result.sessionsEnded };
  }

  /** Resets the second factor (needed when the administrator is the only one). */
  async resetAdminTotp(
    phoneInput: string,
  ): Promise<{ adminId: string; sessionsEnded: number; onlyAdministrator: boolean }> {
    const phone = normalizedPhone(phoneInput);
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const admin = await this.activeAdmin(phone, tx);
      const sessionsEnded = await this.revoker.resetTotp(admin, now, tx);
      const onlyAdministrator = (await this.admins.countActive(tx)) === 1;
      return { admin, sessionsEnded, onlyAdministrator };
    });
    this.logger.log(
      `Admin TOTP reset admin=${result.admin.id} by=operator phone=${maskPhone(phone)} sessionsEnded=${result.sessionsEnded} onlyAdministrator=${result.onlyAdministrator}`,
    );
    return {
      adminId: result.admin.id,
      sessionsEnded: result.sessionsEnded,
      onlyAdministrator: result.onlyAdministrator,
    };
  }

  // Development and tests only: the real flows are TASK-016/TASK-017.

  async createSupplier(input: { name: string; city: string }): Promise<{ supplierId: string }> {
    this.assertLocal();
    const name = input.name.trim();
    const city = input.city.trim();
    if (!name || !city) {
      throw new OperatorCommandError("A company needs a name and a city");
    }
    const created = await this.memberships.createSupplier({ name, city });
    this.logger.log(`Operator: company created supplier=${created.id}`);
    return { supplierId: created.id };
  }

  async addMember(input: {
    supplierId: string;
    phone: string;
    displayName: string;
  }): Promise<{ memberId: string; accountId: string }> {
    this.assertLocal();
    const phone = normalizedPhone(input.phone);
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new OperatorCommandError("An employee needs a name");
    }
    if (!(await this.memberships.findSupplier(input.supplierId))) {
      throw new OperatorCommandError("No such company");
    }
    const account = await this.accounts.findOrCreateByPhone(phone);
    if (account.created) {
      this.logger.log(`Account created account=${account.id} by=operator`);
    }
    const member = await this.memberships.addMember({
      supplierId: input.supplierId,
      accountId: account.id,
      displayName,
    });
    this.logger.log(
      `Operator: employee ${member.created ? "added" : "restored"} supplier=${input.supplierId} member=${member.memberId} account=${account.id} phone=${maskPhone(phone)}`,
    );
    return { memberId: member.memberId, accountId: account.id };
  }

  /**
   * Removes an employee. Every cabinet session of this membership ends in
   * the same transaction, so restoring the membership later brings none
   * of them back; the person's other sessions go on.
   */
  async removeMember(memberId: string): Promise<{ sessionsEnded: number }> {
    this.assertLocal();
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const removed = await this.memberships.markRemoved(memberId, now, tx);
      if (!removed) {
        return undefined;
      }
      const ended = await this.sessions.revokeMemberSessions(memberId, "access_closed", now, tx);
      return { ...removed, ended };
    });
    if (!result) {
      throw new OperatorCommandError("No such active employee");
    }
    for (const sessionId of result.ended) {
      this.logger.log(
        `Session ended session=${sessionId} account=${result.accountId} reason=access_closed`,
      );
    }
    this.logger.log(
      `Operator: employee removed supplier=${result.supplierId} member=${memberId} account=${result.accountId} sessionsEnded=${result.ended.length}`,
    );
    return { sessionsEnded: result.ended.length };
  }

  private async activeAdmin(phone: string, tx: Parameters<AdminUserStore["lock"]>[1]) {
    const account = await this.accounts.findByPhone(phone, tx);
    const admin = account ? await this.admins.lockByAccount(account.id, tx) : undefined;
    if (!admin || admin.status !== "active") {
      throw new OperatorCommandError("This number is not an active administrator");
    }
    return admin;
  }

  private assertLocal(): void {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new OperatorCommandError(
        "Companies and employees are managed in the admin panel and the cabinet; this command works in development and tests only",
      );
    }
  }
}
