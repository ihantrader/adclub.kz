import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Token of an unfinished sign-in (company choice, admin second factor):
 * `st1.<step id>.<256 random bits>`. Only `HMAC(key, "<id>:<secret>")` is
 * stored, the key derived from `SESSION_TOKEN_SECRET` — the database
 * alone yields no usable token.
 */
const PREFIX = "st1";
const PATTERN =
  /^st1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export function newSignInStepToken(stepId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${PREFIX}.${stepId}.${secret}`, secret };
}

export function parseSignInStepToken(token: string): { stepId: string; secret: string } | null {
  const match = PATTERN.exec(token);
  return match ? { stepId: match[1]!, secret: match[2]! } : null;
}

export function hashSignInStepSecret(key: Buffer, stepId: string, secret: string): string {
  return createHmac("sha256", key).update(`${stepId}:${secret}`).digest("base64url");
}

export function signInStepSecretMatches(
  key: Buffer,
  stepId: string,
  secret: string,
  storedHash: string,
): boolean {
  const expected = Buffer.from(hashSignInStepSecret(key, stepId, secret));
  const stored = Buffer.from(storedHash);
  return expected.length === stored.length && timingSafeEqual(expected, stored);
}

/**
 * The client binding of a step: a second random value that never leaves
 * the client's HttpOnly step cookie (`sign-in-step-cookie.ts`). The token
 * from the response body alone doesn't finish the step.
 */
export function newSignInStepBinding(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSignInStepBinding(key: Buffer, stepId: string, binding: string): string {
  return createHmac("sha256", key).update(`binding:${stepId}:${binding}`).digest("base64url");
}

export function signInStepBindingMatches(
  key: Buffer,
  stepId: string,
  binding: string | undefined,
  storedHash: string | null,
): boolean {
  if (binding === undefined || storedHash === null) {
    return false;
  }
  const expected = Buffer.from(hashSignInStepBinding(key, stepId, binding));
  const stored = Buffer.from(storedHash);
  return expected.length === stored.length && timingSafeEqual(expected, stored);
}
