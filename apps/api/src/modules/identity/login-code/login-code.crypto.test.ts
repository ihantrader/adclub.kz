import { describe, expect, it } from "vitest";
import {
  generateLoginCode,
  hashLoginCode,
  loginCodeMatches,
  verifyDelaySeconds,
} from "./login-code.crypto";

const SECRET = "test-secret-test-secret-test-secret";
const CHALLENGE = "5b0f2a36-8d4c-4a57-9d0d-111111111111";

describe("generateLoginCode", () => {
  it("returns digits only, of the requested length", () => {
    for (const length of [4, 6, 8]) {
      const code = generateLoginCode(length);
      expect(code).toMatch(new RegExp(`^\\d{${length}}$`));
    }
  });

  it("is not constant", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateLoginCode(6)));
    expect(codes.size).toBeGreaterThan(40);
  });
});

describe("login code hashing", () => {
  it("never stores the code itself", () => {
    const hash = hashLoginCode(SECRET, CHALLENGE, "123456");
    expect(hash).not.toContain("123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the right code only", () => {
    const hash = hashLoginCode(SECRET, CHALLENGE, "012345");
    expect(loginCodeMatches(SECRET, CHALLENGE, "012345", hash)).toBe(true);
    expect(loginCodeMatches(SECRET, CHALLENGE, "12345", hash)).toBe(false);
    expect(loginCodeMatches(SECRET, CHALLENGE, "012346", hash)).toBe(false);
  });

  it("binds the code to its challenge and to the secret", () => {
    const hash = hashLoginCode(SECRET, CHALLENGE, "123456");
    expect(loginCodeMatches(SECRET, "5b0f2a36-8d4c-4a57-9d0d-222222222222", "123456", hash)).toBe(
      false,
    );
    expect(loginCodeMatches(`${SECRET}x`, CHALLENGE, "123456", hash)).toBe(false);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(loginCodeMatches(SECRET, CHALLENGE, "123456", "abc")).toBe(false);
  });
});

describe("verifyDelaySeconds", () => {
  it("lets the first mistakes through, then doubles the delay", () => {
    expect([0, 1, 2, 3, 4, 5].map((failures) => verifyDelaySeconds(failures, 2, 2))).toEqual([
      0, 0, 0, 2, 4, 8,
    ]);
  });

  it("stays finite for absurd failure counts", () => {
    expect(Number.isFinite(verifyDelaySeconds(10_000, 0, 2))).toBe(true);
  });
});
