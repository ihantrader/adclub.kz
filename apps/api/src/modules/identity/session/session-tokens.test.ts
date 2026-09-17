import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accessTokenIssuer,
  newRefreshSeed,
  parseRefreshToken,
  refreshTokenFor,
  refreshTokenMatches,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from "./session-tokens";

const SECRET = "unit-test-session-token-secret-0123456789";
const ISSUER = accessTokenIssuer("test");
const NOW = 1_800_000_000;

const claims: AccessTokenClaims = {
  sub: randomUUID(),
  sid: randomUUID(),
  knd: "mobile",
  iat: NOW,
  exp: NOW + 900,
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Re-signs arbitrary header/payload with the real access key, as a key holder could. */
function signRaw(header: unknown, payload: unknown, secret = SECRET): string {
  const key = createHmac("sha256", secret).update("adclub.kz session access-token v1").digest();
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

const payloadOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

describe("access tokens", () => {
  const token = signAccessToken(SECRET, ISSUER, claims);

  it("round-trips the claims of a valid token", () => {
    expect(verifyAccessToken(SECRET, ISSUER, token, NOW + 1)).toEqual({ kind: "valid", claims });
  });

  it("carries only ids, kind, issuer and lifetime", () => {
    expect(Object.keys(payloadOf(token)).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "knd", "sid", "sub"].sort(),
    );
    expect(token.split(".")[0]).toBe(b64({ alg: "HS256", typ: "JWT" }));
  });

  it("reports an expired token as expired, not invalid", () => {
    expect(verifyAccessToken(SECRET, ISSUER, token, NOW + 900)).toEqual({
      kind: "expired",
      claims,
    });
  });

  it("rejects a token signed with another secret", () => {
    const foreign = signAccessToken("another-secret-of-another-environment!!", ISSUER, claims);
    expect(verifyAccessToken(SECRET, ISSUER, foreign, NOW)).toEqual({
      kind: "invalid",
      reason: "bad_signature",
    });
  });

  it("rejects a token of another environment even with the same secret", () => {
    const staging = signAccessToken(SECRET, accessTokenIssuer("staging"), claims);
    expect(verifyAccessToken(SECRET, ISSUER, staging, NOW)).toEqual({
      kind: "invalid",
      reason: "wrong_issuer",
    });
  });

  it("rejects a changed payload with the original signature", () => {
    const [header, , signature] = token.split(".");
    for (const change of [
      { sub: randomUUID() },
      { sid: randomUUID() },
      { knd: "admin_web" },
      { exp: NOW + 999_999 },
    ]) {
      const forged = `${header}.${b64({ ...payloadOf(token), ...change })}.${signature}`;
      expect(verifyAccessToken(SECRET, ISSUER, forged, NOW)).toEqual({
        kind: "invalid",
        reason: "bad_signature",
      });
    }
  });

  it("rejects another spelling of the same signature bytes", () => {
    const signature = token.split(".")[2]!;
    const last = signature.at(-1)!;
    // The last of 43 base64url characters carries 2 unused bits.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[(alphabet.indexOf(last) & ~3) | ((alphabet.indexOf(last) + 1) & 3)]!;
    const respelled = `${token.slice(0, -1)}${sibling}`;
    expect(Buffer.from(respelled.split(".")[2]!, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    );
    expect(verifyAccessToken(SECRET, ISSUER, respelled, NOW).kind).toBe("invalid");
  });

  it.each([
    ["an empty string", ""],
    ["garbage", "not a token"],
    ["two parts", "abc.def"],
    ["four parts", `${token}.x`],
    ["a truncated token", token.slice(0, -5)],
    ["a token without its signature", token.split(".").slice(0, 2).join(".") + "."],
    ["a padded token", `${token}==`],
    ["a very long token", `${token}${"A".repeat(3000)}`],
  ])("rejects %s", (_label, value) => {
    expect(verifyAccessToken(SECRET, ISSUER, value, NOW).kind).toBe("invalid");
  });

  it("rejects any other header, including alg none", () => {
    const payload = payloadOf(token);
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
    expect(verifyAccessToken(SECRET, ISSUER, unsigned, NOW).kind).toBe("invalid");
    for (const header of [
      { alg: "none", typ: "JWT" },
      { alg: "HS512", typ: "JWT" },
      { typ: "JWT", alg: "HS256" },
      { alg: "HS256", typ: "JWT", kid: "x" },
    ]) {
      expect(verifyAccessToken(SECRET, ISSUER, signRaw(header, payload), NOW)).toEqual({
        kind: "invalid",
        reason: "unsupported_header",
      });
    }
  });

  it("rejects signed payloads with missing, extra or wrong claims", () => {
    const header = { alg: "HS256", typ: "JWT" };
    const payload = payloadOf(token);
    for (const bad of [
      { ...payload, sub: undefined },
      { ...payload, sid: "not-a-uuid" },
      { ...payload, knd: "root" },
      { ...payload, aud: "someone-else" },
      { ...payload, exp: payload.iat },
      { ...payload, iat: NOW + 3600 },
      { ...payload, role: "admin" },
      "a string payload",
    ]) {
      expect(verifyAccessToken(SECRET, ISSUER, signRaw(header, bad), NOW)).toEqual({
        kind: "invalid",
        reason: "bad_claims",
      });
    }
  });

  it("does not accept a refresh token as an access token", () => {
    const refresh = refreshTokenFor(SECRET, claims.sid, 0, newRefreshSeed());
    expect(verifyAccessToken(SECRET, ISSUER, refresh, NOW).kind).toBe("invalid");
  });
});

describe("refresh tokens", () => {
  const sessionId = randomUUID();
  const seed = newRefreshSeed();

  it("derives a distinct, verifiable token per generation", () => {
    const tokens = [0, 1, 2].map((generation) =>
      refreshTokenFor(SECRET, sessionId, generation, seed),
    );
    expect(new Set(tokens).size).toBe(3);
    tokens.forEach((token, generation) => {
      const parsed = parseRefreshToken(token);
      expect(parsed).toMatchObject({ sessionId, generation });
      expect(refreshTokenMatches(SECRET, parsed!, seed)).toBe(true);
    });
    // Deterministic: the same generation always yields the same token.
    expect(refreshTokenFor(SECRET, sessionId, 1, seed)).toBe(tokens[1]);
  });

  it("does not verify with another seed, secret, session or generation", () => {
    const parsed = parseRefreshToken(refreshTokenFor(SECRET, sessionId, 3, seed))!;
    expect(refreshTokenMatches(SECRET, parsed, newRefreshSeed())).toBe(false);
    expect(refreshTokenMatches("another-secret-of-another-environment!!", parsed, seed)).toBe(
      false,
    );
    expect(refreshTokenMatches(SECRET, { ...parsed, sessionId: randomUUID() }, seed)).toBe(false);
    expect(refreshTokenMatches(SECRET, { ...parsed, generation: 4 }, seed)).toBe(false);
  });

  it("does not verify an altered MAC", () => {
    const token = refreshTokenFor(SECRET, sessionId, 0, seed);
    const flipped = token.slice(0, -2) + (token.at(-2) === "A" ? "B" : "A") + token.at(-1);
    const parsed = parseRefreshToken(flipped);
    expect(parsed).not.toBeNull();
    expect(refreshTokenMatches(SECRET, parsed!, seed)).toBe(false);
  });

  it("never contains the seed", () => {
    expect(refreshTokenFor(SECRET, sessionId, 0, seed)).not.toContain(seed);
  });

  it.each([
    "",
    "rt1",
    `rt2.${sessionId}.0.${"A".repeat(43)}`,
    `rt1.${sessionId.toUpperCase()}.0.${"A".repeat(43)}`,
    `rt1.not-a-uuid.0.${"A".repeat(43)}`,
    `rt1.${sessionId}.01.${"A".repeat(43)}`,
    `rt1.${sessionId}.-1.${"A".repeat(43)}`,
    `rt1.${sessionId}.99999999999.${"A".repeat(43)}`,
    `rt1.${sessionId}.2147483648.${"A".repeat(43)}`,
    `rt1.${sessionId}.0.${"A".repeat(42)}`,
    `rt1.${sessionId}.0.${"A".repeat(43)}.`,
    ` rt1.${sessionId}.0.${"A".repeat(43)}`,
  ])("rejects the malformed refresh token %j", (token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });
});
