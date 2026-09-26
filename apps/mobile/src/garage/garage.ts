/**
 * The garage kept on the device (PRODUCT 6.6, SCREENS M-GAR-01, M-GAR-06;
 * TASK-028). A guest adds cars without an account, so the garage lives next
 * to the language and the city in `createDeviceStore` (ARCHITECTURE 4.37
 * I387) and works without a network.
 *
 * The format is built for the transfer into an account (TASK-029):
 *
 * - a car is **only ids of the vehicle catalog** plus the labels that were
 *   shown when it was chosen. The ids are what the server understands, and
 *   they are exactly what a transfer will send; the labels are a copy for
 *   the screen, so the garage draws itself before `/vehicles/…` answers (and
 *   when it never does);
 * - `id` is made on the device and never leaves it: after the transfer the
 *   account's own id is the one that counts, and this one only tells the two
 *   apart while both exist;
 * - `addedAt` keeps the order in which the guest added the cars, so a merge
 *   can be reproducible;
 * - `sameCar` is the one rule for "this is the same car", used both by the
 *   duplicate question here and by the merge without duplicates later;
 * - `version` lets a later format be recognised instead of silently
 *   mis-parsed.
 */

/** The levels of a car, in the order they are asked for (M-GAR-03). */
export const CAR_LEVELS = [
  "make",
  "model",
  "year",
  "generation",
  "body",
  "engine",
  "transmission",
  "drive",
] as const;

export type CarLevel = (typeof CAR_LEVELS)[number];

/** A chosen level: the id the server knows and the label that was shown. */
export interface CarLevelValue {
  id: string;
  label: string;
}

export interface GarageCar {
  /** Made on this device; the account gets its own on transfer (TASK-029). */
  id: string;
  make: CarLevelValue;
  model: CarLevelValue;
  /** `null` — not chosen; the catalog then simply does not send this level. */
  year: number | null;
  generation: CarLevelValue | null;
  body: CarLevelValue | null;
  engine: CarLevelValue | null;
  transmission: CarLevelValue | null;
  drive: CarLevelValue | null;
  /** Known only when the levels named exactly one modification. */
  modificationId: string | null;
  /** ISO 8601; the order the guest added cars in. */
  addedAt: string;
}

export interface GarageState {
  version: 1;
  cars: GarageCar[];
  /** The car the catalog filters by; `null` — the garage is empty. */
  primaryId: string | null;
}

export const INITIAL_GARAGE: GarageState = { version: 1, cars: [], primaryId: null };

const OPTIONAL_LEVELS = ["generation", "body", "engine", "transmission", "drive"] as const;

function parseLevelValue(raw: unknown): CarLevelValue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (typeof value.label !== "string") return null;
  return { id: value.id, label: value.label };
}

function parseCar(raw: unknown): GarageCar | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const make = parseLevelValue(value.make);
  const model = parseLevelValue(value.model);
  if (!make || !model) return null;
  if (typeof value.id !== "string" || value.id === "") return null;

  const car: GarageCar = {
    id: value.id,
    make,
    model,
    year: typeof value.year === "number" && Number.isInteger(value.year) ? value.year : null,
    generation: parseLevelValue(value.generation),
    body: parseLevelValue(value.body),
    engine: parseLevelValue(value.engine),
    transmission: parseLevelValue(value.transmission),
    drive: parseLevelValue(value.drive),
    modificationId: typeof value.modificationId === "string" ? value.modificationId : null,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : new Date(0).toISOString(),
  };
  return car;
}

/** A stored garage in a shape this version understands; anything else starts empty. */
export function parseGarage(raw: unknown): GarageState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.cars)) return null;
  const cars = value.cars.map(parseCar).filter((car): car is GarageCar => car !== null);
  const primaryId =
    typeof value.primaryId === "string" && cars.some((car) => car.id === value.primaryId)
      ? value.primaryId
      : (cars[0]?.id ?? null);
  return { version: 1, cars, primaryId };
}

/** The one rule for "the same car": every level is the same (TASK-029 merges by it). */
export function sameCar(a: GarageCar, b: GarageCar): boolean {
  return (
    a.make.id === b.make.id &&
    a.model.id === b.model.id &&
    a.year === b.year &&
    OPTIONAL_LEVELS.every((level) => (a[level]?.id ?? null) === (b[level]?.id ?? null))
  );
}

export function findDuplicate(state: GarageState, car: GarageCar): GarageCar | undefined {
  return state.cars.find((existing) => existing.id !== car.id && sameCar(existing, car));
}

/** The first car added becomes the main one (M-GAR-03). */
export function addCar(state: GarageState, car: GarageCar): GarageState {
  const cars = [...state.cars, car];
  return { version: 1, cars, primaryId: state.primaryId ?? car.id };
}

export function replaceCar(state: GarageState, car: GarageCar): GarageState {
  return {
    version: 1,
    cars: state.cars.map((existing) => (existing.id === car.id ? car : existing)),
    primaryId: state.primaryId,
  };
}

export function removeCar(state: GarageState, carId: string): GarageState {
  const cars = state.cars.filter((car) => car.id !== carId);
  // The main car left: the next one takes over, so the catalog keeps filtering.
  const primaryId =
    state.primaryId === carId ? (cars[0]?.id ?? null) : (state.primaryId ?? cars[0]?.id ?? null);
  return { version: 1, cars, primaryId };
}

export function setPrimary(state: GarageState, carId: string): GarageState {
  if (!state.cars.some((car) => car.id === carId)) return state;
  return { version: 1, cars: state.cars, primaryId: carId };
}

export function primaryCar(state: GarageState): GarageCar | null {
  return state.cars.find((car) => car.id === state.primaryId) ?? null;
}

/** «Geely Atlas 2023» — the title of a card and of the catalog's car switch. */
export function carTitle(car: GarageCar): string {
  const parts = [car.make.label, car.model.label];
  if (car.year !== null) parts.push(String(car.year));
  return parts.join(" ");
}

/** «2.0T · Автомат · полный» — the parameter line of M-GAR-01; empty when nothing is known. */
export function carParameters(car: GarageCar): string[] {
  return [car.engine, car.transmission, car.drive, car.body]
    .filter((level): level is CarLevelValue => level !== null)
    .map((level) => level.label);
}

/** Levels the car has no value for, in the order they are asked («Дополнить»). */
export function missingLevels(car: GarageCar): CarLevel[] {
  return CAR_LEVELS.filter((level) => {
    if (level === "make" || level === "model") return false;
    if (level === "year") return car.year === null;
    return car[level] === null;
  });
}

/** A device id that does not need a crypto module and never collides in a garage. */
export function newCarId(now: number, random: () => number = Math.random): string {
  return `car-${now.toString(36)}-${Math.floor(random() * 0xffffff).toString(36)}`;
}
