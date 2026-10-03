import type { Response, Test } from "supertest";

/**
 * Placing an order needs a finished profile — a name and the phone-share
 * consent (`REGISTRATION_INCOMPLETE`, ARCHITECTURE 4.41). The integration
 * tests that sign a customer in only to place orders finish the registration
 * in the one place that signs them in, with this: the request the app sends
 * on its «Как вас зовут?» screen (SCREENS M-AUTH-03), no shortcut around it.
 * Calling it again for an account that is already done is harmless — the
 * route re-affirms the same name and consent.
 */
export const TEST_CUSTOMER_NAME = "Тест Тестов";

export const TEST_CONSENT_VERSION = "test";

/** The name a test customer ends up with, for tests that read it back. */
export async function completeTestRegistration(
  post: (path: string) => Test,
  client: string,
  signedIn: Response,
  name: string = TEST_CUSTOMER_NAME,
): Promise<void> {
  const token = (signedIn.body as { session?: { accessToken?: string } }).session?.accessToken;
  if (signedIn.status !== 200 || !token) {
    return;
  }
  const completed = await post("/auth/complete-registration")
    .set("X-Client", client)
    .set("Authorization", `Bearer ${token}`)
    .send({ name, phoneShareConsent: true, phoneShareConsentVersion: TEST_CONSENT_VERSION });
  if (completed.status !== 200) {
    throw new Error(
      `Test registration did not complete: ${String(completed.status)} ${JSON.stringify(completed.body)}`,
    );
  }
}
