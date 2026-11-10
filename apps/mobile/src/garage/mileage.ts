import type { DashboardResponse } from "@adclub/contracts";
import { mileageVerdict } from "@adclub/domain";
import { replaceCar, type CarMileage, type GarageState } from "./garage";

/**
 * The mileage of a car in the app (TASK-058; SCREENS M-GAR-05…07) — the
 * rules as plain functions, tested without React Native (`mileage.test.ts`).
 *
 * - One rule of a believable reading: `mileageVerdict` of `@adclub/domain`,
 *   the very function the server decides by — so a guest's car on the
 *   device and the account's car ask «Меньше, чем в прошлый раз…» for the
 *   same readings.
 * - Nothing read off a photo is a reading until the person saves it: the
 *   screen holds the recognised value marked «распознано» and only «Всё
 *   верно, сохранить» writes it, with what was read kept next to it.
 */

/** What the person saves: typed, or read off the dashboard and checked. */
export interface MileageReading {
  valueKm: number;
  source: "text" | "photo";
  /** What the photo read; the person may have corrected it. */
  recognizedKm?: number | null;
  /** The id of the recognition (`recognitionId` of `POST /garage/dashboard`). */
  recognitionId?: string | null;
}

/**
 * A reading lower than the last one, not confirmed: the guest's own
 * refusal, shaped as the server's `GARAGE_MILEAGE_LOWER`, so the screen
 * treats both the same.
 */
export class MileageLowerError extends Error {
  readonly code = "GARAGE_MILEAGE_LOWER";
  readonly details: { lastKm: number };

  constructor(lastKm: number) {
    super(`The reading is lower than the last one (${String(lastKm)} km)`);
    this.name = "MileageLowerError";
    this.details = { lastKm };
  }
}

/** The last reading a refusal named («Меньше, чем в прошлый раз ({N} км)»), or `null`. */
export function lowerThanLast(error: unknown): number | null {
  const value = error as { code?: unknown; details?: { lastKm?: unknown } } | null;
  if (value?.code !== "GARAGE_MILEAGE_LOWER") return null;
  return typeof value.details?.lastKm === "number" ? value.details.lastKm : null;
}

/**
 * A guest's reading of a car of the device's garage: the same rule as the
 * server — lower only confirmed, the same changes nothing, out of range is
 * refused (the screen never sends one).
 */
export function withGuestMileage(
  state: GarageState,
  carId: string,
  reading: MileageReading,
  confirmLower: boolean,
  now: Date,
): GarageState {
  const car = state.cars.find((item) => item.id === carId);
  if (!car) return state;
  const verdict = mileageVerdict(reading.valueKm, car.mileage?.valueKm ?? null, confirmLower);
  if (!verdict.ok) {
    if (verdict.reason === "lower") throw new MileageLowerError(verdict.lastKm);
    throw new RangeError("A reading is a whole number from 0 to 2 000 000 km");
  }
  if (verdict.change === "same") return state;
  const mileage: CarMileage = {
    valueKm: reading.valueKm,
    source: reading.source,
    recordedAt: now.toISOString(),
    ...(reading.source === "photo" ? { recognizedKm: reading.recognizedKm ?? null } : {}),
  };
  return replaceCar(state, { ...car, mileage });
}

/** What the photo of the dashboard gave the screen: a reading to check, or why there is none. */
export type DashboardOutcome =
  { kind: "read"; km: number; miles: boolean; recognitionId: string | null } | { kind: "not_read" };

export function dashboardOutcome(answer: DashboardResponse): DashboardOutcome {
  if (answer.kind !== "dashboard" || answer.mileageKm === null) return { kind: "not_read" };
  return {
    kind: "read",
    km: answer.mileageKm,
    miles: answer.unit === "mi",
    recognitionId: answer.recognitionId,
  };
}

/** «45 200» — the kilometres as the card and the field show them (a narrow no-break space). */
export function formatKm(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
}
