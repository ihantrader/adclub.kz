import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionKindSchema, type SessionKind } from "@adclub/contracts";
import { z } from "zod";

/**
 * Session tokens (ARCHITECTURE 8.2, 4.6).
 *
 * Access token — a JWT (RFC 7519) signed with HS256, deliberately limited
 * to one exact header, so `alg: none`, other algorithms and key confusion
 * are rejected by construction. It carries no personal data: account id,
 * session id, session kind, issuer (the environment) and lifetime. A valid
 * signature is not enough: the session row is checked on every request.
 *
 * Refresh token — `rt1.<session id>.<generation>.<mac>`, where
 * `mac = HMAC(key, "<session id>.<generation>.<refresh seed>")`. The seed
 * is random per session and stored; the key never is. So the database
 * alone yields no usable token, the server can recompute the token of
 * any generation (returning the same pair to a retried refresh, and
 * recognizing a replayed old token as proof of theft), and a guessed or
 * altered token fails the MAC without touching the session.
 *
 * Both keys are derived from `SESSION_TOKEN_SECRET`; changing it ends
 * every session.
 */

const ACCESS_TOKEN_HEADER = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
const ACCESS_TOKEN_AUDIENCE = "adclub-api";
const MAX_ACCESS_TOKEN_LENGTH = 2048;
/** Tolerated clock difference between API instances for `iat`. */
const CLOCK_SKEW_SECONDS = 60;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SEED_BYTES = 32;

const REFRESH_TOKEN_PREFIX = "rt1";
const REFRESH_TOKEN_PATTERN =
  /^rt1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9]\d{0,9})\.([A-Za-z0-9_-]{43})$/;
const MAX_GENERATION = 2 ** 31 - 1;

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function deriveKey(secret: string, purpose: "access-token" | "refresh-token"): Buffer {
  return createHmac("sha256", secret).update(`adclub.kz session ${purpose} v1`).digest();
}

function mac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * Constant-time comparison of a presented base64url MAC with the expected
 * bytes. Compares the canonical encodings, not decoded bytes: base64url
 * decoding ignores the spare bits of the last character, so another
 * spelling of the same bytes must not be accepted as the same token.
 */
function macMatches(presented: string, expected: Buffer): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(base64url(expected), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `iss` of the tokens an API instance issues: tokens of another environment don't match. */
export function accessTokenIssuer(nodeEnv: string): string {
  return `adclub-api/${nodeEnv}`;
}

export interface AccessTokenClaims {
  /** Account id. */
  sub: string;
  /** Session id. */
  sid: string;
  knd: SessionKind;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expires at, seconds since the epoch. */
  exp: number;
}

const accessTokenPayloadSchema = z.strictObject({
  iss: z.string(),
  aud: z.literal(ACCESS_TOKEN_AUDIENCE),
  sub: z.uuid(),
  sid: z.uuid(),
  knd: sessionKindSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

export function signAccessToken(secret: string, issuer: string, claims: AccessTokenClaims): string {
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: ACCESS_TOKEN_AUDIENCE,
        sub: claims.sub,
        sid: claims.sid,
        knd: claims.knd,
        iat: claims.iat,
        exp: claims.exp,
      }),
    ),
  );
  const signingInput = `${ACCESS_TOKEN_HEADER}.${payload}`;
  return `${signingInput}.${base64url(mac(deriveKey(secret, "access-token"), signingInput))}`;
}

/** Why a token was refused — for the log only, never for the client. */
export type AccessTokenRejection =
  "malformed" | "unsupported_header" | "bad_signature" | "bad_claims" | "wrong_issuer";

export type AccessTokenCheck =
  | { kind: "valid"; claims: AccessTokenClaims }
  | { kind: "expired"; claims: AccessTokenClaims }
  | { kind: "invalid"; reason: AccessTokenRejection };

/**
 * Checks shape, header, signature and claims — in that order, so nothing
 * of an unsigned payload is trusted. `expired` is only reported for an
 * otherwise valid token.
 */
export function verifyAccessToken(
  secret: string,
  issuer: string,
  token: string,
  nowSeconds: number,
): AccessTokenCheck {
  if (token.length > MAX_ACCESS_TOKEN_LENGTH) {
    return { kind: "invalid", reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
    return { kind: "invalid", reason: "malformed" };
  }
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== ACCESS_TOKEN_HEADER) {
    return { kind: "invalid", reason: "unsupported_header" };
  }
  const expected = mac(deriveKey(secret, "access-token"), `${header}.${payload}`);
  if (!macMatches(signature, expected)) {
    return { kind: "invalid", reason: "bad_signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { kind: "invalid", reason: "bad_claims" };
  }
  const parsed = accessTokenPayloadSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.exp <= parsed.data.iat) {
    return { kind: "invalid", reason: "bad_claims" };
  }
  if (parsed.data.iss !== issuer) {
    return { kind: "invalid", reason: "wrong_issuer" };
  }
  if (parsed.data.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return { kind: "invalid", reason: "bad_claims" };
  }
  const { sub, sid, knd, iat, exp } = parsed.data;
  const claims = { sub, sid, knd, iat, exp };
  return exp <= nowSeconds ? { kind: "expired", claims } : { kind: "valid", claims };
}

/** A fresh per-session seed for refresh tokens (stored in `session.refresh_seed`). */
export function newRefreshSeed(): string {
  return base64url(randomBytes(SEED_BYTES));
}

function refreshMac(secret: string, sessionId: string, generation: number, seed: string): Buffer {
  return mac(deriveKey(secret, "refresh-token"), `${sessionId}.${generation}.${seed}`);
}

export function refreshTokenFor(
  secret: string,
  sessionId: string,
  generation: number,
  seed: string,
): string {
  return [
    REFRESH_TOKEN_PREFIX,
    sessionId,
    generation,
    base64url(refreshMac(secret, sessionId, generation, seed)),
  ].join(".");
}

export interface ParsedRefreshToken {
  sessionId: string;
  generation: number;
  /** base64url, as presented. */
  mac: string;
}

/** Structure only; says nothing about authenticity (see `refreshTokenMatches`). */
export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  const match = REFRESH_TOKEN_PATTERN.exec(token);
  if (!match) {
    return null;
  }
  const generation = Number(match[2]);
  if (generation > MAX_GENERATION) {
    return null;
  }
  return {
    sessionId: match[1]!,
    generation,
    mac: match[3]!,
  };
}

/** Whether the token was issued by this server for this session and generation. */
export function refreshTokenMatches(
  secret: string,
  token: ParsedRefreshToken,
  seed: string,
): boolean {
  return macMatches(token.mac, refreshMac(secret, token.sessionId, token.generation, seed));
}
