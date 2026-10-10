import { CAR_IDENTITY_LEVELS, sameCar, type CarIdentityLevel } from "@adclub/domain";
import { isCarColorId, type CarColorId } from "./car-color";

export { sameCar };

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
 * - `sameCar` is the one rule for "this is the same car" — `@adclub/domain`'s,
 *   the very function the server's merge decides by (ARCHITECTURE 4.41 I447);
 *   it is used here by the duplicate question;
 * - `version` lets a later format be recognised instead of silently
 *   mis-parsed.
 *
 * `color` (D-063, TASK-028.B) was added after `version: 1` shipped: it is
 * read as `null` from a car stored before it existed (`parseCar` below), and
 * it plays no part in `sameCar` — two cars are the same car whatever their
 * paint, and a colour is never part of what the server is asked to match.
 */

/**
 * The levels of a car, in the order they are asked for (M-GAR-03): the very
 * levels the rule of «the same car» compares, so a level cannot be added to
 * the picker without the rule hearing of it.
 */
export const CAR_LEVELS = CAR_IDENTITY_LEVELS;

export type CarLevel = CarIdentityLevel;

/** A chosen level: the id the server knows and the label that was shown. */
export interface CarLevelValue {
  id: string;
  label: string;
}

/**
 * The mark about the car's registration certificate (D-064, TASK-057):
 * `shown` — a certificate was read (when the car was added, or later with
 * «Подтвердить техпаспортом»); `unconfirmed` — the car was chosen from the
 * list after recognition did not work. `proof` is what the recognition
 * signed: a guest keeps it on the device to bring the mark into the account
 * at sign-in; the account's own cars never carry it.
 */
export interface CarDocumentMark {
  status: "shown" | "unconfirmed";
  /** ISO 8601. */
  at: string;
  proof?: string;
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
  /** `null` — not chosen; a car stored before D-063 reads back this way. */
  color: CarColorId | null;
  /** 17 characters, upper case (TASK-057); `null` — not known. */
  vin: string | null;
  /** Compact, `123ABC02`; shown as on the plate. */
  plate: string | null;
  /** `null` — a car added before TASK-057: no mark at all. */
  document: CarDocumentMark | null;
  /** ISO 8601; the order the guest added cars in. */
  addedAt: string;
}

function parseDocument(raw: unknown): CarDocumentMark | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.status !== "shown" && value.status !== "unconfirmed") return null;
  if (typeof value.at !== "string") return null;
  return {
    status: value.status,
    at: value.at,
    ...(typeof value.proof === "string" ? { proof: value.proof } : {}),
  };
}

export interface GarageState {
  version: 1;
  cars: GarageCar[];
  /** The car the catalog filters by; `null` — the garage is empty. */
  primaryId: string | null;
}

export const INITIAL_GARAGE: GarageState = { version: 1, cars: [], primaryId: null };

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
    // Absent in a garage stored before D-063, or a value a later app no
    // longer lists: either way, "не указан" — never a reason to drop the car.
    color: isCarColorId(value.color) ? value.color : null,
    // Absent in a garage stored before TASK-057: no VIN, no plate, no mark.
    vin: typeof value.vin === "string" && value.vin !== "" ? value.vin : null,
    plate: typeof value.plate === "string" && value.plate !== "" ? value.plate : null,
    document: parseDocument(value.document),
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

export function findDuplicate(state: GarageState, car: GarageCar): GarageCar | undefined {
  return state.cars.find((existing) => existing.id !== car.id && sameCar(existing, car));
}

/**
 * Another car of the garage with this VIN (TASK-057, ARCHITECTURE 4.58):
 * one VIN is one car — the server refuses a second one (`GARAGE_VIN_TAKEN`),
 * and the device asks before trying.
 */
export function findVinHolder(state: GarageState, car: GarageCar): GarageCar | undefined {
  if (!car.vin) return undefined;
  return state.cars.find((existing) => existing.id !== car.id && existing.vin === car.vin);
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
