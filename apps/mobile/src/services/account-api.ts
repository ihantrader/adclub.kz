import type {
  AccountCar,
  AccountProfile,
  CarColorId,
  CarLevels,
  CompleteRegistrationBody,
  TransferGarageResponse,
  UpdateAccountProfileBody,
} from "@adclub/contracts";
import type { GarageCar, GarageState } from "../garage/garage";
import { apiClient } from "./api";

/**
 * The account's profile and its own garage (TASK-029, ARCHITECTURE 4.41),
 * the thin layer between the app and the routes `completeRegistration`,
 * `getAccountProfile`, `updateAccountProfile`, `listGarageCars`,
 * `addGarageCar`, `updateGarageCar`, `removeGarageCar`,
 * `setPrimaryGarageCar` and `transferGarage` (`packages/contracts`). Every
 * call site of these routes goes through here, not `apiClient` directly, so
 * the one place that maps the device's `GarageCar` (mobile ARCHITECTURE
 * 4.38 I397) to the wire shape (and back) stays this one.
 */

/** The text version shown for T-AUTH-05 (SCREENS M-AUTH-03); the wording itself is TASK-072's. */
export const PHONE_SHARE_CONSENT_VERSION = "2026-09-mvp";

export function completeRegistration(name: string): Promise<AccountProfile> {
  const body: CompleteRegistrationBody = {
    name,
    phoneShareConsent: true,
    phoneShareConsentVersion: PHONE_SHARE_CONSENT_VERSION,
  };
  return apiClient.completeRegistration(body);
}

export function getAccountProfile(): Promise<AccountProfile> {
  return apiClient.getAccountProfile();
}

export function updateAccountProfile(body: UpdateAccountProfileBody): Promise<AccountProfile> {
  return apiClient.updateAccountProfile(body);
}

function toWireLevels(car: GarageCar): CarLevels {
  return {
    make: car.make,
    model: car.model,
    year: car.year,
    generation: car.generation,
    body: car.body,
    engine: car.engine,
    transmission: car.transmission,
    drive: car.drive,
  };
}

/** The account's car, as the device's own `GarageCar` shape. */
function fromAccountCar(car: AccountCar): GarageCar {
  return {
    id: car.id,
    make: car.make,
    model: car.model,
    year: car.year,
    generation: car.generation,
    body: car.body,
    engine: car.engine,
    transmission: car.transmission,
    drive: car.drive,
    modificationId: car.modificationId,
    color: car.color as GarageCar["color"],
    addedAt: car.createdAt,
  };
}

/** The device's guest garage, in the account after a successful `transferGarage`. */
export function garageStateFromAccountCars(cars: readonly AccountCar[]): GarageState {
  const mapped = cars.map(fromAccountCar);
  const primary = cars.find((car) => car.isPrimary);
  return { version: 1, cars: mapped, primaryId: primary?.id ?? mapped[0]?.id ?? null };
}

/**
 * Sends every car of the device's guest garage (PRODUCT 6.6, TASK-029
 * requirement 5); `primaryId` is the guest garage's own main car — the
 * server keeps it only when the account has none of its own yet.
 * Idempotent: calling it again with the same cars changes nothing.
 */
export function transferGarage(
  cars: readonly GarageCar[],
  primaryId: string | null,
): Promise<TransferGarageResponse> {
  return apiClient.transferGarage({
    cars: cars.map((car) => ({
      levels: toWireLevels(car),
      color: (car.color as CarColorId | null) ?? null,
      isPrimary: car.id === primaryId,
    })),
  });
}
