import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/** A uniformly random numeric code; leading zeros are kept. */
export function generateLoginCode(length: number): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(10));
  }
  return code;
}

/**
 * HMAC of the code bound to its challenge: a database leak alone doesn't
 * reveal codes (a 6-digit space is trivial to brute-force from a plain
 * hash), and a code can't match any other challenge.
 */
export function hashLoginCode(secret: string, challengeId: string, code: string): string {
  return createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("hex");
}

export function loginCodeMatches(
  secret: string,
  challengeId: string,
  code: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashLoginCode(secret, challengeId, code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Seconds a caller must wait after `failures` wrong entries of one code:
 * none for the first `freeFailures` (a person mistyping once or twice is
 * never slowed down), then `baseSeconds`, doubling with each next failure.
 */
export function verifyDelaySeconds(
  failures: number,
  freeFailures: number,
  baseSeconds: number,
): number {
  if (failures <= freeFailures) {
    return 0;
  }
  return baseSeconds * 2 ** Math.min(failures - freeFailures - 1, 16);
}
