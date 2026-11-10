/**
 * The mileage of a car (TASK-058; SCREENS M-GAR-07, M-GAR-05): one rule of
 * what is a believable reading, used by the server before it writes the
 * journal and by the app before it sends — so the app asks «Меньше, чем в
 * прошлый раз…» for exactly the readings the server would refuse.
 *
 * - a reading is a whole number of kilometres from 0 to `MILEAGE_MAX_KM`;
 * - a reading below the last one written is accepted only when the person
 *   said it is right (`confirmLower`): an odometer does not go back, but a
 *   typo yesterday is fixed today;
 * - a reading equal to the last one is not an error and adds nothing.
 */

/** The most kilometres a reading may say (PRODUCT 6.4; nothing on the road has more). */
export const MILEAGE_MAX_KM = 2_000_000;

/** How many kilometres one statute mile is. */
export const KM_PER_MILE = 1.609344;

export type MileageVerdict =
  /** Written as a new reading. */
  | { ok: true; change: "new" }
  /** The same as the last one: nothing is written. */
  | { ok: true; change: "same" }
  /** Not a whole number within 0…`MILEAGE_MAX_KM`. */
  | { ok: false; reason: "range" }
  /** Below the last one, and the person has not said it is right. */
  | { ok: false; reason: "lower"; lastKm: number };

export function isMileageInRange(valueKm: number): boolean {
  return Number.isInteger(valueKm) && valueKm >= 0 && valueKm <= MILEAGE_MAX_KM;
}

/**
 * What a reading means against the last one written (`null` — none yet).
 * `confirmLower` — the person answered «Всё верно» to a lower reading.
 */
export function mileageVerdict(
  valueKm: number,
  lastKm: number | null,
  confirmLower = false,
): MileageVerdict {
  if (!isMileageInRange(valueKm)) return { ok: false, reason: "range" };
  if (lastKm === null || valueKm > lastKm) return { ok: true, change: "new" };
  if (valueKm === lastKm) return { ok: true, change: "same" };
  return confirmLower ? { ok: true, change: "new" } : { ok: false, reason: "lower", lastKm };
}

/** Miles on the dashboard as kilometres, rounded to a whole kilometre. */
export function milesToKm(miles: number): number {
  return Math.round(miles * KM_PER_MILE);
}

/**
 * What a person typed into the «км» field, as a number: digits with spaces
 * or thin spaces between the thousands («45 200»); anything else — `null`.
 */
export function parseMileageInput(text: string): number | null {
  // Only spaces part the thousands: «45.5» or «45,5» is not a reading to guess at.
  const compact = text.replace(/[\s\u00a0\u202f]/gu, "");
  if (!/^\d{1,9}$/u.test(compact)) return null;
  return Number(compact);
}
