import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DbExecutor } from "../../../database";
import { SessionStore } from "../session/session.store";
import { AdminUserStore, type LockedAdmin } from "./admin-user.store";

/**
 * Taking an administrator's rights away, in the caller's transaction and
 * on a locked row: a second factor reset (D-047) or a removal (D-045).
 * Either ends every admin panel session of that administrator at once;
 * their mobile and cabinet sessions are not touched.
 */
@Injectable()
export class AdminAccessRevoker {
  private readonly logger = new Logger("AdminAuth");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AdminUserStore) private readonly admins: AdminUserStore,
    @Inject(SessionStore) private readonly sessions: SessionStore,
  ) {}

  /** The secret and every backup code stop working; setup is due at the next sign-in. */
  async resetTotp(admin: LockedAdmin, now: Date, tx: DbExecutor): Promise<number> {
    await this.admins.clearTotp(admin.id, now, tx);
    return this.endAdminSessions(admin, "totp_reset", now, tx);
  }

  async remove(admin: LockedAdmin, now: Date, tx: DbExecutor): Promise<number> {
    await this.admins.markRemoved(admin.id, now, tx);
    return this.endAdminSessions(admin, "admin_removed", now, tx);
  }

  private async endAdminSessions(
    admin: LockedAdmin,
    reason: "totp_reset" | "admin_removed",
    now: Date,
    tx: DbExecutor,
  ): Promise<number> {
    const ended = await this.sessions.revokeAdminSessions(admin.accountId, reason, now, tx);
    for (const sessionId of ended) {
      this.logger.log(
        `Session ended session=${sessionId} account=${admin.accountId} reason=${reason}`,
      );
    }
    return ended.length;
  }
}
