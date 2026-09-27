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

/**
 * The Postgres driver's own error, however deep a wrapper buried it: Drizzle
 * throws `DrizzleQueryError`, whose `code`/`constraint` live on `.cause`
 * (the `pg` error itself), not on the `DrizzleQueryError` instance — and
 * `withoutQueryParameters` (`database/database-error.ts`) wraps *that* in a
 * plain `Error` for logging, keeping the original one step further down as
 * `.cause` again. One property is `undefined` on none, one, or both of the
 * wrappers a given error passed through, so this walks down until it finds
 * `code`, rather than assuming a fixed depth.
 */
function pgErrorOf(error: unknown): { code?: string; constraint?: string } | undefined {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (typeof candidate.code === "string") {
      return candidate;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** A Postgres foreign-key violation (`23503`) on one of `account_car`'s vehicle references. */
export function isVehicleReferenceViolation(error: unknown): boolean {
  const pgError = pgErrorOf(error);
  return (
    pgError?.code === "23503" &&
    typeof pgError.constraint === "string" &&
    pgError.constraint in LEVEL_BY_CONSTRAINT
  );
}

/** The level a rejected insert or update named, once `isVehicleReferenceViolation` is true. */
export function vehicleReferenceInvalid(error: unknown): ApiException {
  const constraint = pgErrorOf(error)?.constraint ?? "";
  const path = LEVEL_BY_CONSTRAINT[constraint] ?? "levels";
  return new ApiException(400, "VALIDATION_ERROR", "No such vehicle in the catalog", {
    details: [{ path, message: "No such vehicle in the catalog" }],
  });
}
