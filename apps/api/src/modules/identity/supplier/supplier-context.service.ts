import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  CurrentAccountResponse,
  SupplierCompanyResponse,
  SupplierMembershipListResponse,
} from "@adclub/contracts";
import { ApiException } from "../../../common/errors";
import { DatabaseService } from "../../../database";
import { sessionEndedException } from "../session/session-errors";
import { SessionStore } from "../session/session.store";
import { SessionService, type AuthenticatedSession } from "../session/session.service";
import { SupplierMembershipStore } from "./supplier-membership.store";

function companyNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "Company not found");
}

/**
 * The company a cabinet session works for (ARCHITECTURE 8.3): the
 * employee's companies, switching between them, and company data scoped
 * to the session — any other company answers exactly like a missing one.
 */
@Injectable()
export class SupplierContextService {
  private readonly logger = new Logger("SupplierContext");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SupplierMembershipStore) private readonly memberships: SupplierMembershipStore,
    @Inject(SessionStore) private readonly sessionStore: SessionStore,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async listMine(auth: AuthenticatedSession): Promise<SupplierMembershipListResponse> {
    const rows = await this.memberships.listActive(auth.accountId);
    return {
      suppliers: rows.map((row) => ({
        ...row.supplier,
        current: row.supplier.id === auth.supplierId,
      })),
    };
  }

  /**
   * Moves this session to another company of the same employee. From then
   * on the session acts for that company only; a company without an
   * active membership is `NOT_FOUND`, and the session stays where it was.
   */
  async switchTo(auth: AuthenticatedSession, supplierId: string): Promise<CurrentAccountResponse> {
    const previous = auth.supplierId;
    const switched = await this.database.db.transaction(async (tx) => {
      const membership = await this.memberships.findActive(auth.accountId, supplierId, tx);
      if (!membership) {
        return { kind: "no_membership" as const };
      }
      const updated = await this.sessionStore.switchSupplier(
        {
          sessionId: auth.sessionId,
          accountId: auth.accountId,
          supplierId,
          memberId: membership.memberId,
        },
        new Date(),
        tx,
      );
      return updated
        ? { kind: "switched" as const, memberId: membership.memberId }
        : { kind: "session_ended" as const };
    });
    switch (switched.kind) {
      case "no_membership":
        this.logger.warn(
          `Supplier context switch refused: no active membership session=${auth.sessionId} account=${auth.accountId} supplier=${supplierId}`,
        );
        throw companyNotFound();
      case "session_ended":
        throw sessionEndedException();
      case "switched":
        this.logger.log(
          `Supplier context switched session=${auth.sessionId} account=${auth.accountId} from=${previous} to=${supplierId} member=${switched.memberId}`,
        );
        return this.sessions.getCurrent({
          ...auth,
          supplierId,
          supplierMemberId: switched.memberId,
        });
    }
  }

  async company(auth: AuthenticatedSession, supplierId: string): Promise<SupplierCompanyResponse> {
    // Scoped to the session's company: a foreign and an unknown id look the same.
    if (supplierId !== auth.supplierId) {
      throw companyNotFound();
    }
    const row = await this.memberships.findSupplier(supplierId);
    if (!row) {
      throw companyNotFound();
    }
    return { supplier: { id: row.id, name: row.name, city: row.city, status: row.status } };
  }
}
