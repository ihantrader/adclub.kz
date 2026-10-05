import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { accountCar, type AccountCarRow } from "./schema";

export interface NewAccountCar {
  accountId: string;
  makeId: string;
  makeLabel: string;
  modelId: string;
  modelLabel: string;
  year: number | null;
  generationId: string | null;
  generationLabel: string | null;
  bodyTypeId: string | null;
  bodyTypeLabel: string | null;
  engineId: string | null;
  engineLabel: string | null;
  transmissionTypeId: string | null;
  transmissionTypeLabel: string | null;
  driveTypeId: string | null;
  driveTypeLabel: string | null;
  modificationId: string | null;
  color: string | null;
  isPrimary: boolean;
  /** The key of the adding (`POST /garage/cars`); absent — none. */
  idempotencyKey?: string | null;
}

/** Persistence of `account_car` (ARCHITECTURE 4.41). Ownership is enforced
 * here, not layered on afterward: every read or write of one car is scoped
 * to its account, so another account's car is simply not found. */
@Injectable()
export class GarageStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Locks the account row: serializes concurrent adds/transfers of the same account (two devices). */
  async lockAccount(accountId: string, executor: DbExecutor): Promise<void> {
    await executor.execute(sql`SELECT id FROM account WHERE id = ${accountId} FOR UPDATE`);
  }

  async listByAccount(
    accountId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AccountCarRow[]> {
    return executor
      .select()
      .from(accountCar)
      .where(eq(accountCar.accountId, accountId))
      .orderBy(desc(accountCar.createdAt));
  }

  async count(accountId: string, executor: DbExecutor = this.database.db): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(accountCar)
      .where(eq(accountCar.accountId, accountId));
    return row?.count ?? 0;
  }

  async findOwned(
    accountId: string,
    carId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AccountCarRow | undefined> {
    const [row] = await executor
      .select()
      .from(accountCar)
      .where(and(eq(accountCar.id, carId), eq(accountCar.accountId, accountId)));
    return row;
  }

  /** The car an earlier adding with this key made, if it is still there. */
  async findByIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
    executor: DbExecutor,
  ): Promise<AccountCarRow | undefined> {
    const [row] = await executor
      .select()
      .from(accountCar)
      .where(
        and(eq(accountCar.accountId, accountId), eq(accountCar.idempotencyKey, idempotencyKey)),
      );
    return row;
  }

  /**
   * Cars added in one transaction (a transfer) get their own moments, in the
   * order they were inserted: `now()` is the moment the transaction began and
   * would give them all the same one, and "the oldest" and "newest first"
   * would then be a guess.
   */
  async insert(input: NewAccountCar, executor: DbExecutor): Promise<AccountCarRow> {
    const [row] = await executor
      .insert(accountCar)
      .values({ ...input, createdAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .returning();
    return row!;
  }

  /** Replaces the levels and colour of an owned car; `undefined` — not this account's. */
  async updateLevels(
    accountId: string,
    carId: string,
    input: Omit<NewAccountCar, "accountId" | "isPrimary" | "idempotencyKey">,
    executor: DbExecutor,
  ): Promise<AccountCarRow | undefined> {
    const [row] = await executor
      .update(accountCar)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(accountCar.id, carId), eq(accountCar.accountId, accountId)))
      .returning();
    return row;
  }

  /** `undefined` — not this account's car (nothing removed). */
  async remove(
    accountId: string,
    carId: string,
    executor: DbExecutor,
  ): Promise<AccountCarRow | undefined> {
    const [row] = await executor
      .delete(accountCar)
      .where(and(eq(accountCar.id, carId), eq(accountCar.accountId, accountId)))
      .returning();
    return row;
  }

  /** Every other car of the account loses primary status (the partial unique index allows only one). */
  async clearPrimaryExcept(
    accountId: string,
    keepCarId: string | null,
    executor: DbExecutor,
  ): Promise<void> {
    await executor
      .update(accountCar)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(accountCar.accountId, accountId),
          eq(accountCar.isPrimary, true),
          keepCarId ? ne(accountCar.id, keepCarId) : undefined,
        ),
      );
  }

  async setPrimary(
    accountId: string,
    carId: string,
    executor: DbExecutor,
  ): Promise<AccountCarRow | undefined> {
    await this.clearPrimaryExcept(accountId, carId, executor);
    const [row] = await executor
      .update(accountCar)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(and(eq(accountCar.id, carId), eq(accountCar.accountId, accountId)))
      .returning();
    return row;
  }

  /** The car that should become primary after the current primary was removed: the oldest remaining. */
  async oldestId(
    accountId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<string | undefined> {
    const [row] = await executor
      .select({ id: accountCar.id })
      .from(accountCar)
      .where(eq(accountCar.accountId, accountId))
      .orderBy(asc(accountCar.createdAt))
      .limit(1);
    return row?.id;
  }
}
