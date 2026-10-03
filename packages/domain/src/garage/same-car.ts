/**
 * The one rule for «this is the same car» (TASK-029.A, ARCHITECTURE 4.41 I447;
 * PRODUCT 6.6): two cars are the same when every level of the picker names the
 * same catalog entry — compared by id, an empty level equal only to an empty
 * level. The colour (D-063), a label, a device id, the modification id and
 * the time a car was added never take part.
 *
 * Both sides of the merge decide by this and nothing else: the app asks it
 * about two `GarageCar`s of the device's garage, the server about a row of
 * the account's garage and the car it was sent. Their data have different
 * shapes, so the rule is stated over a flat `CarIdentity` that each side
 * brings its own car to — the shapes are adapted, the rule is not copied.
 */

/** The levels of the car picker, in the order they are asked (M-GAR-03). */
export const CAR_IDENTITY_LEVELS = [
  "make",
  "model",
  "year",
  "generation",
  "body",
  "engine",
  "transmission",
  "drive",
] as const;

export type CarIdentityLevel = (typeof CAR_IDENTITY_LEVELS)[number];

/**
 * A car reduced to what makes it this car: an id per level, the year as
 * a number, `null` where a level is not chosen. A record keyed by every
 * level — a level added to `CAR_IDENTITY_LEVELS` is a compile error in every
 * adapter that builds one, until it says what its value is.
 */
export type CarIdentity = Readonly<Record<CarIdentityLevel, string | number | null>>;

/** A chosen level of a car as the device and the contract carry it. */
export interface CarLevelRef {
  readonly id: string;
}

/** The levels of a car in the shape of the picker, the device and the API contract. */
export interface CarLevelsLike {
  readonly make: CarLevelRef;
  readonly model: CarLevelRef;
  readonly year: number | null;
  readonly generation?: CarLevelRef | null;
  readonly body?: CarLevelRef | null;
  readonly engine?: CarLevelRef | null;
  readonly transmission?: CarLevelRef | null;
  readonly drive?: CarLevelRef | null;
}

/** The identity of a car given as chosen levels (the device's `GarageCar`, the contract's `CarLevels`). */
export function carIdentity(levels: CarLevelsLike): CarIdentity {
  return {
    make: levels.make.id,
    model: levels.model.id,
    year: levels.year ?? null,
    generation: levels.generation?.id ?? null,
    body: levels.body?.id ?? null,
    engine: levels.engine?.id ?? null,
    transmission: levels.transmission?.id ?? null,
    drive: levels.drive?.id ?? null,
  };
}

/** The rule itself: every level the same, an unchosen level only the same as an unchosen one. */
export function sameCarIdentity(a: CarIdentity, b: CarIdentity): boolean {
  return CAR_IDENTITY_LEVELS.every((level) => a[level] === b[level]);
}

/** The rule asked of two cars given as chosen levels. */
export function sameCar(a: CarLevelsLike, b: CarLevelsLike): boolean {
  return sameCarIdentity(carIdentity(a), carIdentity(b));
}
