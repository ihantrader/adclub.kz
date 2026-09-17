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
