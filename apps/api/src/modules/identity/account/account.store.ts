import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { account } from "../schema";

export interface AccountRecord {
  id: string;
  phone: string;
  createdAt: Date;
}

const columns = { id: account.id, phone: account.phone, createdAt: account.createdAt };

/** Persistence of `account` (ARCHITECTURE 5.1): one account per phone number. */
@Injectable()
export class AccountStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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
    const [existing] = await executor.select(columns).from(account).where(eq(account.phone, phone));
    if (!existing) {
      throw new Error("Account vanished between insert and select");
    }
    return { ...existing, created: false };
  }
}
