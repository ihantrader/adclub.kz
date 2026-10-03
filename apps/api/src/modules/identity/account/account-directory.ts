import { Inject, Injectable } from "@nestjs/common";
import { maskPhone } from "@adclub/domain";
import { inArray } from "drizzle-orm";
import { DatabaseService } from "../../../database";
import { account } from "../schema";

/**
 * What other modules may learn about accounts without reading identity
 * tables (ARCHITECTURE 4): phone numbers, partly hidden only. Stateless;
 * a module that needs it lists it among its own providers.
 */
@Injectable()
export class AccountDirectory {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** `+7***4567` by account id; unknown ids are left out. */
  async maskedPhones(accountIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.database.db
      .select({ id: account.id, phone: account.phone })
      .from(account)
      .where(inArray(account.id, ids));
    return new Map(rows.map((row) => [row.id, maskPhone(row.phone)]));
  }
}
