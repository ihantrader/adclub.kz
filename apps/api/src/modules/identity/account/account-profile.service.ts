import { Inject, Injectable } from "@nestjs/common";
import type {
  AccountProfile,
  CompleteRegistrationBody,
  UpdateAccountProfileBody,
} from "@adclub/contracts";
import { isRegistrationComplete } from "@adclub/domain";
import { ApiException } from "../../../common/errors";
import { DatabaseService } from "../../../database";
import { ActionJournal } from "../action-journal";
import { AccountStore, type AccountProfileRow } from "./account.store";

/** A Postgres foreign-key violation (`city_id` naming a city that doesn't exist). */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23503"
  );
}

function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

/** Collapses the inner whitespace a keyboard leaves (the schema only trims the edges). */
function collapseSpaces(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * The account's profile (TASK-029, ARCHITECTURE 4.41): finishing
 * registration (a name and the phone-share consent — SCREENS M-AUTH-03) and
 * reading/changing "Мои данные" (M-PRO-02) afterward. The phone number is
 * never part of a body here (PRODUCT 6.1); the contract already leaves it
 * out of every request schema, so there is nothing more to reject beyond
 * what `updateAccountProfileBodySchema`'s `.strict()` already refuses.
 *
 * Every write and its journal entry share one transaction (ARCHITECTURE
 * 4.13, TASK-009): a failure to record either rolls back both, so the
 * consent recorded at registration is never silently unaudited.
 */
@Injectable()
export class AccountProfileService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountStore) private readonly accounts: AccountStore,
    // `ActionJournal` (declared in `identity`, bound to the concrete
    // `AuditLog` in `AuditModule`), not `AuditLog` itself: importing the
    // audit module's own class here would make `identity` depend on
    // `audit`, which already depends on `identity` (`ActionJournal`,
    // `AccountDirectory`) — a cycle that broke `SessionRoute` at module
    // load (found while adding the garage module's integration test,
    // TASK-029 report, "Errors & Fixes"). `admin-auth.service.ts` and
    // `operator.service.ts` already use this same port for the same reason.
    @Inject(ActionJournal) private readonly auditLog: ActionJournal,
  ) {}

  /**
   * `POST /auth/complete-registration`. Giving a name and the consent again
   * later (a retry, or the same values sent twice) is not an error — the
   * route's own doc says so: it simply records the fields again, and the
   * consent's `at` moves to the newer moment.
   */
  async complete(accountId: string, body: CompleteRegistrationBody): Promise<AccountProfile> {
    const name = collapseSpaces(body.name);
    const now = new Date();
    const row = await this.database.db.transaction(async (tx) => {
      const updated = await this.accounts.completeRegistration(
        accountId,
        { name, consentVersion: body.phoneShareConsentVersion, now },
        tx,
      );
      await this.auditLog.record(
        {
          action: "account.registration_completed",
          actor: { role: "user", accountId },
          entityType: "account",
          entityId: accountId,
          after: { name, consentVersion: body.phoneShareConsentVersion },
        },
        tx,
      );
      return updated;
    });
    return this.toProfile(row);
  }

  async get(accountId: string): Promise<AccountProfile> {
    const row = await this.accounts.findProfile(accountId);
    if (!row) {
      throw new Error("Account of an authenticated session vanished");
    }
    return this.toProfile(row);
  }

  /** `PATCH /account/profile`. `email: null` also turns the newsletter consent off (`AccountStore`). */
  async update(accountId: string, body: UpdateAccountProfileBody): Promise<AccountProfile> {
    try {
      const row = await this.database.db.transaction(async (tx) => {
        const before = await this.accounts.findProfile(accountId, tx);
        if (!before) {
          throw new Error("Account of an authenticated session vanished");
        }
        const name = body.name !== undefined ? collapseSpaces(body.name) : undefined;
        const updated = await this.accounts.updateProfile(
          accountId,
          {
            name,
            email: body.email,
            emailNewsConsent: body.emailNewsConsent,
            cityId: body.cityId,
            language: body.language,
          },
          tx,
        );
        await this.auditLog.record(
          {
            action: "account.profile_updated",
            actor: { role: "user", accountId },
            entityType: "account",
            entityId: accountId,
            before: {
              name: before.name,
              email: before.email,
              emailNewsConsent: before.emailNewsConsent,
              cityId: before.cityId,
              language: before.language,
            },
            after: {
              name: updated.name,
              email: updated.email,
              emailNewsConsent: updated.emailNewsConsent,
              cityId: updated.cityId,
              language: updated.language,
            },
          },
          tx,
        );
        return updated;
      });
      return this.toProfile(row);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw validationError("cityId", "No such city");
      }
      throw error;
    }
  }

  private toProfile(row: AccountProfileRow): AccountProfile {
    return {
      name: row.name,
      phone: row.phone,
      email: row.email,
      emailNewsConsent: row.emailNewsConsent,
      cityId: row.cityId,
      language: row.language,
      // The one rule of "is this a finished club member" (`@adclub/domain`),
      // the same one `orders.service.ts` gates order creation with.
      registrationCompleted: isRegistrationComplete(row),
      phoneShareConsent:
        row.consentPhoneShareAt && row.consentVersion
          ? { version: row.consentVersion, at: row.consentPhoneShareAt.toISOString() }
          : null,
    };
  }
}
