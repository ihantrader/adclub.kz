import { Inject, Injectable } from "@nestjs/common";
import {
  CAR_COLOR_IDS,
  type AccountCar,
  type CarLevels,
  type GarageCarsResponse,
  type SaveGarageCarBody,
  type TransferGarageBody,
  type TransferGarageResponse,
} from "@adclub/contracts";
import { DatabaseService } from "../../database";
import { AppSettings } from "../settings";
import {
  garageCarNotFound,
  garageLimitReached,
  isVehicleReferenceViolation,
  vehicleReferenceInvalid,
} from "./garage-errors";
import { sameLevels } from "./garage-merge";
import { GarageStore, type NewAccountCar } from "./garage.store";
import type { AccountCarRow } from "./schema";

function levelsOf(levels: CarLevels): Omit<NewAccountCar, "accountId" | "isPrimary" | "color"> {
  return {
    makeId: levels.make.id,
    makeLabel: levels.make.label,
    modelId: levels.model.id,
    modelLabel: levels.model.label,
    year: levels.year,
    generationId: levels.generation?.id ?? null,
    generationLabel: levels.generation?.label ?? null,
    bodyTypeId: levels.body?.id ?? null,
    bodyTypeLabel: levels.body?.label ?? null,
    engineId: levels.engine?.id ?? null,
    engineLabel: levels.engine?.label ?? null,
    transmissionTypeId: levels.transmission?.id ?? null,
    transmissionTypeLabel: levels.transmission?.label ?? null,
    driveTypeId: levels.drive?.id ?? null,
    driveTypeLabel: levels.drive?.label ?? null,
    modificationId: null,
  };
}

function toAccountCar(row: AccountCarRow): AccountCar {
  const color = (CAR_COLOR_IDS as readonly string[]).includes(row.color ?? "")
    ? (row.color as AccountCar["color"])
    : null;
  return {
    id: row.id,
    make: { id: row.makeId, label: row.makeLabel },
    model: { id: row.modelId, label: row.modelLabel },
    year: row.year,
    generation: row.generationId
      ? { id: row.generationId, label: row.generationLabel ?? "" }
      : null,
    body: row.bodyTypeId ? { id: row.bodyTypeId, label: row.bodyTypeLabel ?? "" } : null,
    engine: row.engineId ? { id: row.engineId, label: row.engineLabel ?? "" } : null,
    transmission: row.transmissionTypeId
      ? { id: row.transmissionTypeId, label: row.transmissionTypeLabel ?? "" }
      : null,
    drive: row.driveTypeId ? { id: row.driveTypeId, label: row.driveTypeLabel ?? "" } : null,
    modificationId: row.modificationId,
    color,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The account's own garage (PRODUCT 6.4, 6.6; ARCHITECTURE 4.41; TASK-029
 * requirement 2): CRUD scoped to the caller's account, and the
 * merge-without-duplicates transfer of a device's guest garage. Every
 * method takes the account id from the authenticated session
 * (`@CurrentSession()`), never from the request body — a car cannot be
 * added to, or read from, anyone else's garage.
 */
@Injectable()
export class GarageService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(GarageStore) private readonly store: GarageStore,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async list(accountId: string): Promise<GarageCarsResponse> {
    const rows = await this.store.listByAccount(accountId);
    return { cars: rows.map(toAccountCar) };
  }

  /**
   * `make`/`model`/`generation`/`engine` are real foreign keys to the
   * vehicle catalog (the migration's own comment explains why the other
   * levels aren't); a client that names one that doesn't (or no longer)
   * exist gets a plain `VALIDATION_ERROR` naming the level, not a raw
   * database error.
   */
  private async withVehicleReferenceCheck<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isVehicleReferenceViolation(error)) {
        throw vehicleReferenceInvalid(error);
      }
      throw error;
    }
  }

  async add(accountId: string, body: SaveGarageCarBody): Promise<AccountCar> {
    const limit = await this.settings.get("garage_max_cars");
    return this.withVehicleReferenceCheck(() =>
      this.database.db.transaction(async (tx) => {
        await this.store.lockAccount(accountId, tx);
        const count = await this.store.count(accountId, tx);
        if (count >= limit) {
          throw garageLimitReached(limit);
        }
        const row = await this.store.insert(
          {
            accountId,
            ...levelsOf(body.levels),
            color: body.color,
            // The first car of an empty garage is primary by itself — the
            // same rule as the device (mobile ARCHITECTURE 4.38 I397).
            isPrimary: count === 0,
          },
          tx,
        );
        return toAccountCar(row);
      }),
    );
  }

  async update(accountId: string, carId: string, body: SaveGarageCarBody): Promise<AccountCar> {
    const row = await this.withVehicleReferenceCheck(() =>
      this.store.updateLevels(
        accountId,
        carId,
        { ...levelsOf(body.levels), color: body.color },
        this.database.db,
      ),
    );
    if (!row) {
      throw garageCarNotFound();
    }
    return toAccountCar(row);
  }

  async remove(accountId: string, carId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.store.lockAccount(accountId, tx);
      const removed = await this.store.remove(accountId, carId, tx);
      if (!removed) {
        throw garageCarNotFound();
      }
      if (removed.isPrimary) {
        // The main car left: the oldest of what remains takes over, so the
        // catalog keeps filtering (same rule as the device, TASK-028).
        const nextId = await this.store.oldestId(accountId, tx);
        if (nextId) {
          await this.store.setPrimary(accountId, nextId, tx);
        }
      }
    });
  }

  async setPrimary(accountId: string, carId: string): Promise<AccountCar> {
    const row = await this.database.db.transaction(async (tx) => {
      await this.store.lockAccount(accountId, tx);
      // Ownership is settled before anything is touched: a car that is not
      // this account's (or is gone) must not cost the account its primary.
      if (!(await this.store.findOwned(accountId, carId, tx))) {
        throw garageCarNotFound();
      }
      const updated = await this.store.setPrimary(accountId, carId, tx);
      if (!updated) {
        throw garageCarNotFound();
      }
      return updated;
    });
    return toAccountCar(row);
  }

  /**
   * Merges a device's guest garage into the account's own, without
   * duplicates (requirement 2), idempotent (calling it again with the same
   * cars changes nothing): each submitted car is compared, by levels only
   * (never colour), against every car the account already has and every
   * car this same call has already added; a match adds nothing. The
   * account row is locked for the whole transaction, so two devices of one
   * person transferring at the same moment merge one after the other, not
   * into two racing copies (edge case, TASK-029).
   *
   * The primary stays whatever the account already had (the device's
   * choice counts only while the account has none); only an account with none yet
   * takes the device's own primary, or — if none of the submitted cars was
   * marked primary — the first one merged, so a garage that gains its first
   * car always ends up with exactly one primary.
   *
   * Never refuses for the size limit: a sign-in must not fail over it
   * (`garage_max_cars` is meant to be generous). If the account is already
   * at the limit, cars beyond it are simply left untransferred; the device
   * keeps them and a later transfer (after some are removed) picks them up.
   */
  async transfer(accountId: string, body: TransferGarageBody): Promise<TransferGarageResponse> {
    const limit = await this.settings.get("garage_max_cars");
    return this.withVehicleReferenceCheck(() =>
      this.database.db.transaction(async (tx) => {
        await this.store.lockAccount(accountId, tx);
        const existing = await this.store.listByAccount(accountId, tx);
        const hadPrimary = existing.some((row) => row.isPrimary);
        const merged: AccountCarRow[] = [...existing];
        let transferred = 0;
        let primaryCandidateId: string | null = null;

        for (const car of body.cars) {
          const match = merged.find((row) => sameLevels(row, car.levels));
          let resolvedId: string;
          if (match) {
            resolvedId = match.id;
          } else {
            if (merged.length >= limit) {
              // Generous limit reached mid-merge: leave the rest on the
              // device rather than fail the whole sign-in.
              continue;
            }
            const inserted = await this.store.insert(
              { accountId, ...levelsOf(car.levels), color: car.color, isPrimary: false },
              tx,
            );
            merged.push(inserted);
            transferred += 1;
            resolvedId = inserted.id;
          }
          if (!hadPrimary && primaryCandidateId === null && car.isPrimary) {
            primaryCandidateId = resolvedId;
          }
        }

        if (!hadPrimary && merged.length > 0) {
          // No submitted car claimed primary (a well-behaved device always
          // sends one when it has any car) — fall back to the first merged,
          // so the garage never ends up with cars and no primary at all.
          const chosen = primaryCandidateId ?? merged[0]!.id;
          await this.store.setPrimary(accountId, chosen, tx);
        }

        const finalRows = await this.store.listByAccount(accountId, tx);
        return { cars: finalRows.map(toAccountCar), transferred };
      }),
    );
  }
}
