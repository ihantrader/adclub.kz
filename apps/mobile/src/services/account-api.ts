import type {
  AccountProfile,
  CompleteRegistrationBody,
  UpdateAccountProfileBody,
} from "@adclub/contracts";
import { apiClient } from "./api";

/**
 * The account's profile (TASK-029, ARCHITECTURE 4.41): the thin layer between
 * the app and the routes `completeRegistration`, `getAccountProfile` and
 * `updateAccountProfile` (`packages/contracts`). The account's garage — its
 * routes and the transfer of the guest garage — is `services/account-garage.ts`
 * (TASK-029.B, ARCHITECTURE 4.46).
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
