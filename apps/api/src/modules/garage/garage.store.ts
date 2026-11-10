import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { accountCar, mileageLog, type AccountCarRow, type MileageLogRow } from "./schema";

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
  vin?: string | null;
  plate?: string | null;
  documentStatus?: "shown" | "unconfirmed" | null;
  documentAt?: Date | null;
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

  /** Another car of the account with this VIN, if there is one. */
  async findByVin(
    accountId: string,
    vin: string,
    executor: DbExecutor,
  ): Promise<AccountCarRow | undefined> {
    const [row] = await executor
      .select()
      .from(accountCar)
      .where(and(eq(accountCar.accountId, accountId), eq(accountCar.vin, vin)));
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

  /**
   * The current reading of each car (TASK-058): its latest by `recorded_at`
   * (two readings of one moment — the one written last).
   */
  async latestMileage(
    carIds: readonly string[],
    executor: DbExecutor = this.database.db,
  ): Promise<Map<string, MileageLogRow>> {
    if (carIds.length === 0) return new Map();
    const rows = await executor
      .selectDistinctOn([mileageLog.carId])
      .from(mileageLog)
      .where(inArray(mileageLog.carId, [...carIds]))
      .orderBy(mileageLog.carId, desc(mileageLog.recordedAt), desc(mileageLog.createdAt));
    return new Map(rows.map((row) => [row.carId, row]));
  }

  /**
   * Whether the car's journal already holds this value within `windowMs` of
   * `around` — a transfer repeated (its moment is clamped to «now», so a
   * device whose clock runs ahead sends a new moment each time). The same
   * value months apart is a genuine new reading.
   */
  async hasMileageValueNear(
    carId: string,
    valueKm: number,
    around: Date,
    windowMs: number,
    executor: DbExecutor,
  ): Promise<boolean> {
    const [row] = await executor
      .select({ id: mileageLog.id })
      .from(mileageLog)
      .where(
        and(
          eq(mileageLog.carId, carId),
          eq(mileageLog.valueKm, valueKm),
          gte(mileageLog.recordedAt, new Date(around.getTime() - windowMs)),
          lte(mileageLog.recordedAt, new Date(around.getTime() + windowMs)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * A reading of the journal. The same car, moment and value again — a
   * transfer repeated — writes nothing (`undefined`).
   */
  async insertMileage(
    input: Omit<MileageLogRow, "id" | "createdAt">,
    executor: DbExecutor,
  ): Promise<MileageLogRow | undefined> {
    const [row] = await executor
      .insert(mileageLog)
      .values({ ...input, createdAt: sql`clock_timestamp()` })
      .onConflictDoNothing({
        target: [mileageLog.carId, mileageLog.recordedAt, mileageLog.valueKm],
      })
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
