import { Inject, Injectable } from "@nestjs/common";
import {
  CAR_COLOR_IDS,
  type AccountCar,
  type AddGarageCarBody,
  type CarDocumentInput,
  type CarLevels,
  type GarageCarsResponse,
  type SaveGarageCarBody,
  type TransferGarageBody,
  type TransferGarageResponse,
} from "@adclub/contracts";
import { checkVin, normalizeKzPlate, normalizeVin } from "@adclub/domain";
import { DatabaseService } from "../../database";
import { AppSettings } from "../settings";
import { DocumentProofs } from "../vehicle-document";
import {
  garageCarNotFound,
  garageFieldInvalid,
  garageLimitReached,
  garageVinTaken,
  isVehicleReferenceViolation,
  isVinTakenViolation,
  vehicleReferenceInvalid,
} from "./garage-errors";
import { sameLevels } from "./garage-merge";
import { GarageStore, type NewAccountCar } from "./garage.store";
import type { AccountCarRow } from "./schema";

/**
 * The levels and the modification of a car as columns. The modification is
 * kept as the device sent it (TASK-029.B): it never takes part in «the same
 * car» (I435), and an older client that does not send it stores `null`.
 */
function levelsOf(
  levels: CarLevels,
  modificationId: string | null | undefined,
): Omit<NewAccountCar, "accountId" | "isPrimary" | "color"> {
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
    modificationId: modificationId ?? null,
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
    vin: row.vin,
    plate: row.plate,
    document:
      row.documentStatus && row.documentAt
        ? { status: row.documentStatus, at: row.documentAt.toISOString() }
        : null,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A VIN of the body (T-GAR-07): left out — `undefined` (unchanged), `null`
 * or empty — cleared, otherwise checked and kept compact in upper case. A
 * VIN that is not one is refused, never corrected.
 */
function vinOf(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const checked = checkVin(value);
  if (!checked.ok) {
    throw garageFieldInvalid(
      "vin",
      checked.reason === "length"
        ? "A VIN is 17 characters"
        : "A VIN is letters and digits without I, O and Q",
    );
  }
  return checked.vin;
}

/** A plate of the body: as on a Kazakhstan plate, kept compact (T-GAR-07). */
function plateOf(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const plate = normalizeKzPlate(value);
  if (plate === null) {
    throw garageFieldInvalid("plate", "Not a Kazakhstan registration plate");
  }
  return plate;
}

interface DocumentMark {
  documentStatus: "shown" | "unconfirmed";
  documentAt: Date;
}

/**
 * The account's own garage (PRODUCT 6.4, 6.6; ARCHITECTURE 4.41; TASK-029
 * requirement 2): CRUD scoped to the caller's account, and the
 * merge-without-duplicates transfer of a device's guest garage. Every
 * method takes the account id from the authenticated session
 * (`@CurrentSession()`), never from the request body — a car cannot be
 * added to, or read from, anyone else's garage.
 *
 * With TASK-057 (D-064, ARCHITECTURE 4.58) a car carries its VIN, its plate
 * and the mark about its document: «документ показан» only with a proof the
 * recognition signed, «документ не подтверждён» for a car chosen from the
 * list. One VIN is one car within a garage.
 */
@Injectable()
export class GarageService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(GarageStore) private readonly store: GarageStore,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(DocumentProofs) private readonly proofs: DocumentProofs,
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
   * database error. A VIN another car took in a race the lock did not
   * cover is the same `GARAGE_VIN_TAKEN` as one found beforehand.
   */
  private async withReferenceChecks<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isVehicleReferenceViolation(error)) {
        throw vehicleReferenceInvalid(error);
      }
      if (isVinTakenViolation(error)) {
        throw garageVinTaken(null);
      }
      throw error;
    }
  }

  /**
   * The mark a new car gets from what the app said: `shown` with a proof
   * the server signed (the moment is the proof's), `unconfirmed` now, or
   * none. A proof that does not check out is refused (`strict`), or — in a
   * transfer, which must never fail a sign-in — read as `unconfirmed`.
   */
  private markOf(
    input: CarDocumentInput | null | undefined,
    path: string,
    strict: boolean,
  ): DocumentMark | null {
    if (!input) return null;
    if (input.status === "unconfirmed") {
      return { documentStatus: "unconfirmed", documentAt: new Date() };
    }
    const at = this.proofs.read(input.proof);
    if (at) return { documentStatus: "shown", documentAt: at };
    if (strict) {
      throw garageFieldInvalid(path, "The proof of the document was not issued by this server");
    }
    return { documentStatus: "unconfirmed", documentAt: new Date() };
  }

  /**
   * Adds a car. `idempotencyKey` (TASK-029.B): the same key again — the
   * answer to the first request was lost on the way and the app asks again —
   * gives back the car the first one added, before the size limit is even
   * looked at, so a repeat never adds a second car and never fails for a
   * limit the first request already counted. The account row lock makes two
   * racing repeats wait for each other; the unique index
   * `account_car_idempotency_key` holds the rule in the database as well.
   */
  async add(accountId: string, body: AddGarageCarBody): Promise<AccountCar> {
    const vin = vinOf(body.vin) ?? null;
    const plate = plateOf(body.plate) ?? null;
    const mark = this.markOf(body.document, "document.proof", true);
    const limit = await this.settings.get("garage_max_cars");
    return this.withReferenceChecks(() =>
      this.database.db.transaction(async (tx) => {
        await this.store.lockAccount(accountId, tx);
        if (body.idempotencyKey) {
          const earlier = await this.store.findByIdempotencyKey(accountId, body.idempotencyKey, tx);
          if (earlier) return toAccountCar(earlier);
        }
        const count = await this.store.count(accountId, tx);
        if (count >= limit) {
          throw garageLimitReached(limit);
        }
        if (vin) {
          const holder = await this.store.findByVin(accountId, vin, tx);
          if (holder) throw garageVinTaken(holder.id);
        }
        const row = await this.store.insert(
          {
            accountId,
            ...levelsOf(body.levels, body.modificationId),
            color: body.color,
            vin,
            plate,
            ...(mark ?? {}),
            idempotencyKey: body.idempotencyKey ?? null,
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

  /**
   * A change of a car: the levels and the colour are replaced; the VIN and
   * the plate only when the body names them (an app from before TASK-057
   * does not, and must not wipe them); the mark only rises — a proof makes
   * it «документ показан» («Подтвердить техпаспортом»), nothing takes it
   * back.
   */
  async update(accountId: string, carId: string, body: SaveGarageCarBody): Promise<AccountCar> {
    const vin = vinOf(body.vin);
    const plate = plateOf(body.plate);
    const mark =
      body.document?.status === "shown" ? this.markOf(body.document, "document.proof", true) : null;
    const row = await this.withReferenceChecks(() =>
      this.database.db.transaction(async (tx) => {
        await this.store.lockAccount(accountId, tx);
        if (vin) {
          const holder = await this.store.findByVin(accountId, vin, tx);
          if (holder && holder.id !== carId) throw garageVinTaken(holder.id);
        }
        return this.store.updateLevels(
          accountId,
          carId,
          {
            ...levelsOf(body.levels, body.modificationId),
            color: body.color,
            ...(vin === undefined ? {} : { vin }),
            ...(plate === undefined ? {} : { plate }),
            ...(mark ?? {}),
          },
          tx,
        );
      }),
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
   * cars changes nothing): each submitted car is compared against every car
   * the account already has and every car this same call has already added;
   * a match adds nothing. «The same car» is the same VIN when both cars
   * have one (TASK-057), and otherwise the same levels (never colour) —
   * unless the two VINs differ, which makes them two cars. A match takes
   * what the account's car lacks: a VIN and a plate it has none of, and a
   * mark that rises («документ показан» over none or «не подтверждён»).
   * The account row is locked for the whole transaction, so two devices of
   * one person transferring at the same moment merge one after the other,
   * not into two racing copies (edge case, TASK-029).
   *
   * The primary stays whatever the account already had (the device's
   * choice counts only while the account has none); only an account with none yet
   * takes the device's own primary, or — if none of the submitted cars was
   * marked primary — the first one merged, so a garage that gains its first
   * car always ends up with exactly one primary.
   *
   * Never refuses — not for the size limit, not for a VIN, a plate or a
   * proof that does not check out: a sign-in must not fail over a guest's
   * car. If the account is already at the limit, cars beyond it are simply
   * left untransferred; the device keeps them and a later transfer (after
   * some are removed) picks them up.
   */
  async transfer(accountId: string, body: TransferGarageBody): Promise<TransferGarageResponse> {
    const limit = await this.settings.get("garage_max_cars");
    return this.withReferenceChecks(() =>
      this.database.db.transaction(async (tx) => {
        await this.store.lockAccount(accountId, tx);
        const existing = await this.store.listByAccount(accountId, tx);
        const hadPrimary = existing.some((row) => row.isPrimary);
        const merged: AccountCarRow[] = [...existing];
        let transferred = 0;
        let primaryCandidateId: string | null = null;

        for (const car of body.cars) {
          const vin = normalizeVin(car.vin);
          const plate = normalizeKzPlate(car.plate);
          const mark = this.markOf(car.document, "document.proof", false);
          const match =
            (vin ? merged.find((row) => row.vin === vin) : undefined) ??
            merged.find(
              (row) => sameLevels(row, car.levels) && !(row.vin && vin && row.vin !== vin),
            );
          let resolvedId: string;
          if (match) {
            resolvedId = match.id;
            const enriched = await this.enrich(accountId, match, merged, { vin, plate, mark }, tx);
            if (enriched) {
              merged[merged.indexOf(match)] = enriched;
            }
          } else {
            if (merged.length >= limit) {
              // Generous limit reached mid-merge: leave the rest on the
              // device rather than fail the whole sign-in.
              continue;
            }
            const inserted = await this.store.insert(
              {
                accountId,
                ...levelsOf(car.levels, car.modificationId),
                color: car.color,
                vin,
                plate,
                ...(mark ?? {}),
                isPrimary: false,
              },
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

  /**
   * What a guest's car brings to the account's same car in a transfer: a
   * VIN and a plate it has none of (a VIN no other car of the account holds),
   * and a mark that rises. `null` — nothing to change.
   */
  private async enrich(
    accountId: string,
    row: AccountCarRow,
    merged: readonly AccountCarRow[],
    guest: { vin: string | null; plate: string | null; mark: DocumentMark | null },
    tx: Parameters<GarageStore["updateLevels"]>[3],
  ): Promise<AccountCarRow | null> {
    const changes: Partial<NewAccountCar> = {};
    if (!row.vin && guest.vin && !merged.some((other) => other.vin === guest.vin)) {
      changes.vin = guest.vin;
    }
    if (!row.plate && guest.plate) {
      changes.plate = guest.plate;
    }
    const rises =
      guest.mark &&
      (row.documentStatus === null ||
        (row.documentStatus === "unconfirmed" && guest.mark.documentStatus === "shown"));
    if (rises && guest.mark) {
      changes.documentStatus = guest.mark.documentStatus;
      changes.documentAt = guest.mark.documentAt;
    }
    if (Object.keys(changes).length === 0) return null;
    const updated = await this.store.updateLevels(
      accountId,
      row.id,
      { ...levelsOfRow(row), color: row.color, ...changes },
      tx,
    );
    return updated ?? null;
  }
}

/** A row's own levels, to write back unchanged next to the fields a transfer adds. */
function levelsOfRow(row: AccountCarRow): Omit<NewAccountCar, "accountId" | "isPrimary" | "color"> {
  return {
    makeId: row.makeId,
    makeLabel: row.makeLabel,
    modelId: row.modelId,
    modelLabel: row.modelLabel,
    year: row.year,
    generationId: row.generationId,
    generationLabel: row.generationLabel,
    bodyTypeId: row.bodyTypeId,
    bodyTypeLabel: row.bodyTypeLabel,
    engineId: row.engineId,
    engineLabel: row.engineLabel,
    transmissionTypeId: row.transmissionTypeId,
    transmissionTypeLabel: row.transmissionTypeLabel,
    driveTypeId: row.driveTypeId,
    driveTypeLabel: row.driveTypeLabel,
    modificationId: row.modificationId,
  };
}
