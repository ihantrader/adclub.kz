import { Inject, Injectable } from "@nestjs/common";
import type {
  AcceptConsentsBody,
  AccountConsent,
  AccountProfile,
  CompleteRegistrationBody,
  UpdateAccountProfileBody,
} from "@adclub/contracts";
import { isRegistrationComplete } from "@adclub/domain";
import { ApiException } from "../../../common/errors";
import { DatabaseService, FOREIGN_KEY_VIOLATION, postgresError } from "../../../database";
import { ActionJournal } from "../action-journal";
import { AccountConsents, type ConsentSource } from "./account-consents";
import { AccountStore, type AccountProfileRow } from "./account.store";
import { whatsappAvailable, whatsappWordOf } from "./whatsapp-reach";

function validationError(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

/** The latest consent to share the number, from the journal (the latest first). */
export function phoneShareOf(
  consents: readonly AccountConsent[],
): { version: string; at: string } | null {
  const latest = consents.find((entry) => entry.kind === "phone_share");
  return latest ? { version: latest.version, at: latest.at } : null;
}

/** Collapses the inner whitespace a keyboard leaves (the schema only trims the edges). */
function collapseSpaces(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/**
 * The account's profile (TASK-029, ARCHITECTURE 4.41): finishing
 * registration (a name and the phone-share consent — SCREENS M-AUTH-03) and
 * reading/changing "Мои данные" (M-PRO-02) afterward. The phone number is
 * never part of a body here (PRODUCT 6.1): `updateAccountProfileBodySchema`
 * refuses a body that names it, so it never reaches this service.
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
    @Inject(AccountConsents) private readonly consents: AccountConsents,
  ) {}

  /**
   * `POST /auth/complete-registration`. Giving a name and the consent again
   * later (a retry, or the same values sent twice) is not an error — the
   * route's own doc says so: it simply records the fields again, and the
   * consent's `at` moves to the newer moment.
   */
  async complete(
    accountId: string,
    body: CompleteRegistrationBody,
    source: ConsentSource | null = null,
  ): Promise<AccountProfile> {
    const name = collapseSpaces(body.name);
    const now = new Date();
    // TASK-072: the versions are the server's (the settings), not the one an
    // app sends — an older app still sends its constant and is still served.
    const versions = await this.consents.currentVersions();
    const row = await this.database.db.transaction(async (tx) => {
      const updated = await this.accounts.completeRegistration(
        accountId,
        { name, consentVersion: versions.phone_share, now },
        tx,
      );
      // M-AUTH-03: the number to a supplier (T-AUTH-05) and the terms.
      await this.consents.give(tx, accountId, ["phone_share", "terms"], source, {
        at: now,
        again: true,
      });
      // The name is not written to the journal (TASK-072): an entry stays
      // after the account is deleted, the name must not.
      await this.auditLog.record(
        {
          action: "account.registration_completed",
          actor: { role: "user", accountId },
          entityType: "account",
          entityId: accountId,
          after: { consentVersion: versions.phone_share, termsVersion: versions.terms },
        },
        tx,
      );
      return updated;
    });
    return this.toProfile(row, await this.whatsappOf(row.phone));
  }

  async get(accountId: string): Promise<AccountProfile> {
    const row = await this.accounts.findProfile(accountId);
    if (!row) {
      throw new Error("Account of an authenticated session vanished");
    }
    return this.toProfile(row, await this.whatsappOf(row.phone));
  }

  /**
   * `POST /account/consents` (TASK-072): «Принять» on «Мы обновили
   * условия». The kinds named (all outdated ones when left out) are given
   * for their current versions; one already current is not written again.
   */
  async acceptConsents(
    accountId: string,
    body: AcceptConsentsBody,
    source: ConsentSource,
  ): Promise<AccountProfile> {
    await this.database.db.transaction(async (tx) => {
      const kinds = body.kinds ?? (await this.consents.state(accountId, tx)).outdated;
      const given = await this.consents.give(tx, accountId, kinds, source);
      if (given.length === 0) {
        return;
      }
      const phoneShare = given.find((entry) => entry.kind === "phone_share");
      if (phoneShare) {
        // The account keeps the date of its last phone-share consent: the
        // registration gate (`isRegistrationComplete`) reads it.
        await this.accounts.recordPhoneShareConsent(accountId, phoneShare.version, new Date(), tx);
      }
      await this.auditLog.record(
        {
          action: "account.consents_accepted",
          actor: { role: "user", accountId },
          entityType: "account",
          entityId: accountId,
          after: { consents: given },
        },
        tx,
      );
    });
    return this.get(accountId);
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
            remindersEnabled: body.remindersEnabled,
          },
          tx,
        );
        await this.auditLog.record(
          {
            action: "account.profile_updated",
            actor: { role: "user", accountId },
            entityType: "account",
            entityId: accountId,
            // TASK-072: the name and the e-mail of these entries are taken
            // out when the account is deleted (`AccountDeletion`); the
            // administrator sees the history of the profile until then.
            before: {
              name: before.name,
              email: before.email,
              emailNewsConsent: before.emailNewsConsent,
              cityId: before.cityId,
              language: before.language,
              remindersEnabled: before.remindersEnabled,
            },
            after: {
              name: updated.name,
              email: updated.email,
              emailNewsConsent: updated.emailNewsConsent,
              cityId: updated.cityId,
              language: updated.language,
              remindersEnabled: updated.remindersEnabled,
            },
          },
          tx,
        );
        return updated;
      });
      return await this.toProfile(row, await this.whatsappOf(row.phone));
    } catch (error) {
      // `city_id` naming a city that doesn't exist.
      if (postgresError(error)?.code === FOREIGN_KEY_VIOLATION) {
        throw validationError("cityId", "No such city");
      }
      throw error;
    }
  }

  /** M-PRO-04 (TASK-052): the last decisive word about the number. */
  private async whatsappOf(phone: string): Promise<boolean> {
    return whatsappAvailable(await whatsappWordOf(this.database.db, phone));
  }

  private async toProfile(row: AccountProfileRow, whatsapp: boolean): Promise<AccountProfile> {
    const consents = await this.consents.state(row.id);
    // Until the registration is finished it is M-AUTH-03 that asks for the
    // consents, not «Мы обновили условия».
    const outdated = isRegistrationComplete(row) ? consents.outdated : [];
    return {
      consents: consents.consents,
      consentsOutdated: outdated.length > 0,
      outdatedConsents: outdated,
      name: row.name,
      phone: row.phone,
      email: row.email,
      emailNewsConsent: row.emailNewsConsent,
      cityId: row.cityId,
      language: row.language,
      // The one rule of "is this a finished club member" (`@adclub/domain`),
      // the same one `orders.service.ts` gates order creation with.
      registrationCompleted: isRegistrationComplete(row),
      // TASK-072: from the journal of consents (the latest of its kind).
      phoneShareConsent: phoneShareOf(consents.consents),
      whatsappAvailable: whatsapp,
      remindersEnabled: row.remindersEnabled,
    };
  }
}
