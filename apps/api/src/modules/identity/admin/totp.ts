import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) as authenticator apps implement it by default:
 * HMAC-SHA1, 30-second steps, 6 digits. A few dozen lines on
 * `node:crypto` instead of a library, like the access token (4.6 I47).
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid base32 character");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new random secret (160 bits, base32 — what the app is given). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one time step (HOTP, RFC 4226, with the step as counter). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * The time step `code` belongs to, looking `driftSteps` steps back and
 * forward (device clocks run early or late), or `null`. Only steps after
 * `lastUsedStep` count: a code, once accepted, is never accepted again,
 * and neither is any earlier one.
 */
export function matchTotp(
  secret: string,
  code: string,
  nowMs: number,
  driftSteps: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Every candidate is compared, so timing doesn't tell which one matched.
  for (let step = current - driftSteps; step <= current + driftSteps; step++) {
    const expected = Buffer.from(totpCode(secret, step));
    const equal = timingSafeEqual(expected, Buffer.from(code));
    if (equal && matched === null && (lastUsedStep === null || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched;
}

/** `otpauth://` URI — the content of the QR code authenticator apps scan. */
export function totpUri(secret: string, issuer: string, accountName: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
