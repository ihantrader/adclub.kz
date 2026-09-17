import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  newSignInStepToken,
  parseSignInStepToken,
  hashSignInStepSecret,
  signInStepSecretMatches,
} from "../session/sign-in-step-token";
import {
  deriveAdminKeys,
  generateBackupCode,
  hashBackupCode,
  normalizeBackupCode,
  openSecret,
  sealSecret,
} from "./admin-crypto";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  matchTotp,
  totpCode,
  totpStep,
  totpUri,
} from "./totp";

// RFC 6238, appendix B (SHA1 seed), last six digits of the eight-digit values.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("TOTP", () => {
  it.each(RFC_VECTORS)("matches RFC 6238 at t=%i", (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it("round-trips base32 and makes 160-bit secrets", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
    expect(() => base32Decode("abc1")).toThrow();
  });

  it("accepts a code one step early or late, not two", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const secret = generateTotpSecret();
    for (const offset of [-1, 0, 1]) {
      expect(matchTotp(secret, totpCode(secret, step + offset), now, 1, null)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      expect(matchTotp(secret, totpCode(secret, step + offset), now, 1, null)).toBeNull();
    }
    expect(matchTotp(secret, totpCode(secret, step + 1), now, 0, null)).toBeNull();
  });

  it("never accepts a code for a step at or before the last used one", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const secret = generateTotpSecret();
    const code = totpCode(secret, step);
    expect(matchTotp(secret, code, now, 1, step - 1)).toBe(step);
    expect(matchTotp(secret, code, now, 1, step)).toBeNull();
    expect(matchTotp(secret, totpCode(secret, step - 1), now, 1, step)).toBeNull();
    expect(matchTotp(secret, totpCode(secret, step + 1), now, 1, step)).toBe(step + 1);
  });

  it("refuses anything that isn't six digits", () => {
    const secret = generateTotpSecret();
    for (const code of ["", "12345", "1234567", "12345a", "１２３４５６"]) {
      expect(matchTotp(secret, code, Date.now(), 1, null)).toBeNull();
    }
  });

  it("builds the otpauth URI authenticator apps scan", () => {
    const uri = new URL(totpUri("JBSWY3DPEHPK3PXP", "Asia Drive Club", "+7***4567"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Asia Drive Club:+7***4567");
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "Asia Drive Club",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });
});

describe("secret box", () => {
  const keys = deriveAdminKeys("a-test-key-material-of-at-least-32-chars");

  it("encrypts with a fresh IV and decrypts only in the same context with the same key", () => {
    const context = randomUUID();
    const sealed = sealSecret(keys.encryption, context, "JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(sealSecret(keys.encryption, context, "JBSWY3DPEHPK3PXP")).not.toBe(sealed);
    expect(openSecret(keys.encryption, context, sealed)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => openSecret(keys.encryption, randomUUID(), sealed)).toThrow();
    const other = deriveAdminKeys("another-key-material-of-at-least-32-chars");
    expect(() => openSecret(other.encryption, context, sealed)).toThrow();
    const [prefix, iv, tag, data] = sealed.split(".") as [string, string, string, string];
    const flipped = `${data[0] === "A" ? "B" : "A"}${data.slice(1)}`;
    expect(() =>
      openSecret(keys.encryption, context, [prefix, iv, tag, flipped].join(".")),
    ).toThrow();
    expect(() => openSecret(keys.encryption, context, "v2.x.y.z")).toThrow();
  });

  it("derives different keys for different purposes", () => {
    expect(keys.encryption.equals(keys.backupCodes)).toBe(false);
    expect(keys.encryption).toHaveLength(32);
  });
});

describe("backup codes", () => {
  const key = deriveAdminKeys("a-test-key-material-of-at-least-32-chars").backupCodes;

  it("look like xxxx-xxxx without ambiguous characters and don't repeat", () => {
    const codes = new Set(Array.from({ length: 200 }, generateBackupCode));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    }
  });

  it("accept case, spaces and dashes as typed, nothing else", () => {
    expect(normalizeBackupCode("AbCd-2345")).toBe("abcd2345");
    expect(normalizeBackupCode(" abcd 2345 ")).toBe("abcd2345");
    for (const input of ["abcd-234", "abcd-23456", "abcd-2340", "abcl-2345", "abcd_2345"]) {
      expect(normalizeBackupCode(input)).toBeNull();
    }
  });

  it("hash with a key, per administrator", () => {
    const admin = randomUUID();
    const hash = hashBackupCode(key, admin, "abcd2345");
    expect(hash).not.toContain("abcd2345");
    expect(hashBackupCode(key, admin, "abcd2345")).toBe(hash);
    expect(hashBackupCode(key, randomUUID(), "abcd2345")).not.toBe(hash);
    const otherKey = deriveAdminKeys("another-key-material-of-at-least-32-chars").backupCodes;
    expect(hashBackupCode(otherKey, admin, "abcd2345")).not.toBe(hash);
  });
});

describe("sign-in step tokens", () => {
  const key = Buffer.alloc(32, 7);

  it("carry the step id and a secret only a keyed hash of which is stored", () => {
    const stepId = randomUUID();
    const { token, secret } = newSignInStepToken(stepId);
    expect(parseSignInStepToken(token)).toEqual({ stepId, secret });
    const hash = hashSignInStepSecret(key, stepId, secret);
    expect(hash).not.toContain(secret);
    expect(signInStepSecretMatches(key, stepId, secret, hash)).toBe(true);
    expect(signInStepSecretMatches(key, randomUUID(), secret, hash)).toBe(false);
    expect(signInStepSecretMatches(Buffer.alloc(32, 8), stepId, secret, hash)).toBe(false);
    const other = newSignInStepToken(stepId);
    expect(signInStepSecretMatches(key, stepId, other.secret, hash)).toBe(false);
  });

  it.each([
    "",
    "st1",
    "st2.x.y",
    `st1.${randomUUID()}.short`,
    `st1.not-a-uuid.${"a".repeat(43)}`,
    `st1.${randomUUID()}.${"a".repeat(43)}.x`,
  ])("refuses a malformed token %j", (token) => {
    expect(parseSignInStepToken(token)).toBeNull();
  });
});
