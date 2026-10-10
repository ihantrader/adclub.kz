import { ApiException } from "../../common/errors";
import { FOREIGN_KEY_VIOLATION, postgresError } from "../../database";

/**
 * Contract errors of the account's garage (ARCHITECTURE 4.41). A car that
 * belongs to another account is never distinguished from one that doesn't
 * exist (requirement 2) — every lookup here is scoped to the caller's own
 * `accountId`, so the store simply finds nothing and this is what's thrown.
 */
export function garageCarNotFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such car in this account's garage");
}

export function garageLimitReached(limit: number): ApiException {
  return new ApiException(
    409,
    "GARAGE_LIMIT_REACHED",
    `The garage already has as many cars as this account may have (${String(limit)})`,
    { details: { limit } },
  );
}

/** One VIN is one car (TASK-057, ARCHITECTURE 4.58): another car of this garage has it. */
export function garageVinTaken(carId: string | null): ApiException {
  return new ApiException(
    409,
    "GARAGE_VIN_TAKEN",
    "Another car of this garage already has this VIN",
    { details: { carId } },
  );
}

/** The database refused a second car with one VIN in one garage (a race the service lost). */
export function isVinTakenViolation(error: unknown): boolean {
  const pgError = postgresError(error);
  return pgError?.code === "23505" && pgError.constraint === "account_car_vin_key";
}

/** A field of the body that does not hold what it says (T-GAR-07, a proof the server never signed). */
export function garageFieldInvalid(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
}

/** Which level a car's foreign key names, from the constraint Postgres refused. */
const LEVEL_BY_CONSTRAINT: Record<string, string> = {
  account_car_make_id_fkey: "levels.make.id",
  account_car_model_id_fkey: "levels.model.id",
  account_car_generation_id_fkey: "levels.generation.id",
  account_car_engine_id_fkey: "levels.engine.id",
  account_car_modification_id_fkey: "modificationId",
};

/** A Postgres foreign-key violation on one of `account_car`'s vehicle references. */
export function isVehicleReferenceViolation(error: unknown): boolean {
  const pgError = postgresError(error);
  return (
    pgError?.code === FOREIGN_KEY_VIOLATION &&
    pgError.constraint !== undefined &&
    pgError.constraint in LEVEL_BY_CONSTRAINT
  );
}

/** The level a rejected insert or update named, once `isVehicleReferenceViolation` is true. */
export function vehicleReferenceInvalid(error: unknown): ApiException {
  const constraint = postgresError(error)?.constraint ?? "";
  const path = LEVEL_BY_CONSTRAINT[constraint] ?? "levels";
  return new ApiException(400, "VALIDATION_ERROR", "No such vehicle in the catalog", {
    details: [{ path, message: "No such vehicle in the catalog" }],
  });
}
