import { Inject, Injectable } from "@nestjs/common";
import { maskPhone } from "@adclub/domain";
import { eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../../../database";
import { account, adminUser, supplierMember } from "../schema";

/** How a person is shown in the admin panel: the name if given, the number partly hidden. */
export interface ShownPerson {
  name: string | null;
  phoneMasked: string;
}

/**
 * What other modules may learn about accounts without reading identity
 * tables (ARCHITECTURE 4): phone numbers, partly hidden only, and names.
 * Stateless; a module that needs it lists it among its own providers.
 */
@Injectable()
export class AccountDirectory {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** `+7***4567` by account id; unknown ids are left out. */
  async maskedPhones(accountIds: readonly string[]): Promise<Map<string, string>> {
    const people = await this.accounts(accountIds);
    return new Map([...people].map(([id, person]) => [id, person.phoneMasked]));
  }

  /** The name and the hidden number by account id (TASK-034); unknown ids are left out. */
  async accounts(accountIds: readonly string[]): Promise<Map<string, ShownPerson>> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.database.db
      .select({ id: account.id, phone: account.phone, name: account.name })
      .from(account)
      .where(inArray(account.id, ids));
    return new Map(
      rows.map((row) => [row.id, { name: row.name, phoneMasked: maskPhone(row.phone) }]),
    );
  }

  /** The same by administrator id (former administrators too). */
  async administrators(adminIds: readonly string[]): Promise<Map<string, ShownPerson>> {
    const ids = [...new Set(adminIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.database.db
      .select({ id: adminUser.id, phone: account.phone, name: account.name })
      .from(adminUser)
      .innerJoin(account, eq(account.id, adminUser.accountId))
      .where(inArray(adminUser.id, ids));
    return new Map(
      rows.map((row) => [row.id, { name: row.name, phoneMasked: maskPhone(row.phone) }]),
    );
  }

  /** The name an employee has in their company, by membership id (removed ones too). */
  async memberNames(memberIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(memberIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.database.db
      .select({ id: supplierMember.id, name: supplierMember.displayName })
      .from(supplierMember)
      .where(inArray(supplierMember.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
