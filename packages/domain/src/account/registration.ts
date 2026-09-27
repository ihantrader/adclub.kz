/**
 * Whether an account is a participant of the club, not just a phone number
 * that has received a login code (PRODUCT 6.1; SCREENS M-AUTH-03; TASK-029
 * requirement 1). A name and the consent to share the phone number with a
 * supplier are both given at the same step (M-AUTH-03's "Готово"), so either
 * being missing means registration isn't finished — the one place this
 * decision is made, so a route that requires a club member and `GET /auth/me`
 * never disagree about it.
 */
export interface RegistrationFacts {
  name: string | null;
  consentPhoneShareAt: Date | string | null;
}

export function isRegistrationComplete(account: RegistrationFacts): boolean {
  return account.name !== null && account.name !== "" && account.consentPhoneShareAt !== null;
}
