import { Inject, Injectable } from "@nestjs/common";
import type { CatalogLanguage } from "@adclub/contracts";
import { eq } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { account } from "../schema";

export interface AccountRecord {
  id: string;
  phone: string;
  createdAt: Date;
}

const columns = { id: account.id, phone: account.phone, createdAt: account.createdAt };

/** The account's profile (TASK-029, ARCHITECTURE 4.41): everything `GET /account/profile` answers. */
export interface AccountProfileRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  emailNewsConsent: boolean;
  cityId: string | null;
  language: CatalogLanguage | null;
  consentPhoneShareAt: Date | null;
  consentVersion: string | null;
  createdAt: Date;
}

/** Only what decides whether an account may act as a club member (the orders gate). */
export interface RegistrationFactsRow {
  name: string | null;
  consentPhoneShareAt: Date | null;
}

const profileColumns = {
  id: account.id,
  phone: account.phone,
  name: account.name,
  email: account.email,
  emailNewsConsent: account.emailNewsConsent,
  cityId: account.cityId,
  language: account.language,
  consentPhoneShareAt: account.consentPhoneShareAt,
  consentVersion: account.consentVersion,
  createdAt: account.createdAt,
};

export interface UpdateAccountProfileInput {
  name?: string;
  email?: string | null;
  emailNewsConsent?: boolean;
  cityId?: string | null;
  language?: CatalogLanguage;
}

/** Persistence of `account` (ARCHITECTURE 5.1): one account per phone number. */
@Injectable()
export class AccountStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findById(id: string, executor: DbExecutor = this.database.db): Promise<AccountRecord> {
    const [row] = await executor.select(columns).from(account).where(eq(account.id, id));
    if (!row) {
      throw new Error("Account not found");
    }
    return row;
  }

  /** The account of a phone number, if one exists (never creates it, D-046). */
  async findByPhone(
    phone: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AccountRecord | undefined> {
    const [row] = await executor.select(columns).from(account).where(eq(account.phone, phone));
    return row;
  }

  /**
   * The account of a confirmed phone number, created on first use. The
   * unique index on `phone` makes concurrent first sign-ins converge on
   * one row: a losing insert does nothing and the row is read back.
   */
  async findOrCreateByPhone(
    phone: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AccountRecord & { created: boolean }> {
    const [inserted] = await executor
      .insert(account)
      .values({ phone })
      .onConflictDoNothing({ target: account.phone })
      .returning(columns);
    if (inserted) {
      return { ...inserted, created: true };
    }
    const existing = await this.findByPhone(phone, executor);
    if (!existing) {
      throw new Error("Account vanished between insert and select");
    }
    return { ...existing, created: false };
  }

  /** The full profile (`GET /account/profile`, `GET /auth/me`'s additive fields). */
  async findProfile(
    id: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AccountProfileRow | undefined> {
    const [row] = await executor.select(profileColumns).from(account).where(eq(account.id, id));
    return row;
  }

  /**
   * Only what decides whether the account may act as a club member (TASK-029
   * requirement 1, ARCHITECTURE 4.41): a cheap read for a route that only
   * needs the gate, not the whole profile (`OrdersService.create`).
   */
  async registrationFacts(
    id: string,
    executor: DbExecutor = this.database.db,
  ): Promise<RegistrationFactsRow | undefined> {
    const [row] = await executor
      .select({ name: account.name, consentPhoneShareAt: account.consentPhoneShareAt })
      .from(account)
      .where(eq(account.id, id));
    return row;
  }

  /**
   * `POST /auth/complete-registration` (SCREENS M-AUTH-03 «Готово»): gives
   * the name and records the phone-share consent with its version and the
   * moment it was given. Calling it again is not an error — it simply sets
   * the fields again (the route's own contract, `completeRegistrationBodySchema`).
   */
  async completeRegistration(
    id: string,
    input: { name: string; consentVersion: string; now: Date },
    executor: DbExecutor = this.database.db,
  ): Promise<AccountProfileRow> {
    await executor
      .update(account)
      .set({
        name: input.name,
        consentPhoneShareAt: input.now,
        consentVersion: input.consentVersion,
        updatedAt: input.now,
      })
      .where(eq(account.id, id));
    const row = await this.findProfile(id, executor);
    if (!row) {
      throw new Error("Account vanished during registration completion");
    }
    return row;
  }

  /**
   * `PATCH /account/profile` (SCREENS M-PRO-02 «Мои данные», and the silent
   * transfer of the device's city and language after registration, TASK-029
   * requirement 5). Setting `email` to `null` also turns `emailNewsConsent`
   * off — a consent about an address that no longer exists cannot stay on —
   * unless the same request also sets a new address.
   */
  async updateProfile(
    id: string,
    patch: UpdateAccountProfileInput,
    executor: DbExecutor = this.database.db,
  ): Promise<AccountProfileRow> {
    const values: Partial<typeof account.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.email !== undefined) values.email = patch.email;
    if (patch.cityId !== undefined) values.cityId = patch.cityId;
    if (patch.language !== undefined) values.language = patch.language;
    if (patch.emailNewsConsent !== undefined) {
      values.emailNewsConsent = patch.emailNewsConsent;
    }
    if (patch.email === null && patch.emailNewsConsent === undefined) {
      values.emailNewsConsent = false;
    }
    await executor.update(account).set(values).where(eq(account.id, id));
    const row = await this.findProfile(id, executor);
    if (!row) {
      throw new Error("Account vanished during a profile update");
    }
    return row;
  }
}
