import type {
  AccountProfile,
  CompleteRegistrationBody,
  TransferGarageResponse,
  UpdateAccountProfileBody,
} from "@adclub/contracts";
import { toWireLevels } from "../garage/account-cars";
import type { GarageCar } from "../garage/garage";
import { apiClient } from "./api";

/**
 * The account's profile and the transfer of the device's garage into it (TASK-029,
 * ARCHITECTURE 4.41): the thin layer between the app and the routes
 * `completeRegistration`, `getAccountProfile`, `updateAccountProfile` and
 * `transferGarage` (`packages/contracts`). The five garage routes of the
 * account (`listGarageCars`, `addGarageCar`, …) have no call here on purpose:
 * after the transfer the garage tab still writes to the device (I433). Every
 * call goes through here, not `apiClient` directly, so the one place that maps
 * the device's `GarageCar` (mobile ARCHITECTURE 4.38 I397) to the wire shape
 * (and back) stays this one.
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
      color: car.color,
      isPrimary: car.id === primaryId,
    })),
  });
}
