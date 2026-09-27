import { ApiException } from "../../common/errors";

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

/** Which level a car's foreign key names, from the constraint Postgres refused. */
const LEVEL_BY_CONSTRAINT: Record<string, string> = {
  account_car_make_id_fkey: "levels.make.id",
  account_car_model_id_fkey: "levels.model.id",
  account_car_generation_id_fkey: "levels.generation.id",
  account_car_engine_id_fkey: "levels.engine.id",
};

/** A Postgres foreign-key violation (`23503`) on one of `account_car`'s vehicle references. */
export function isVehicleReferenceViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23503" &&
    typeof (error as { constraint?: string }).constraint === "string" &&
    (error as { constraint: string }).constraint in LEVEL_BY_CONSTRAINT
  );
}

/** The level a rejected insert or update named, once `isVehicleReferenceViolation` is true. */
export function vehicleReferenceInvalid(error: unknown): ApiException {
  const constraint = (error as { constraint: string }).constraint;
  const path = LEVEL_BY_CONSTRAINT[constraint] ?? "levels";
  return new ApiException(400, "VALIDATION_ERROR", "No such vehicle in the catalog", {
    details: [{ path, message: "No such vehicle in the catalog" }],
  });
}
