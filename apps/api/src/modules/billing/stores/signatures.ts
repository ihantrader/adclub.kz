import {
  createSign,
  verify as verifySignature,
  X509Certificate,
  type KeyObject,
} from "node:crypto";

/**
 * Signatures of the stores (TASK-041, ARCHITECTURE 4.98) on plain
 * `node:crypto` — no SDK of a store, no JOSE library:
 *
 * - `verifyAppleJws` — a JWS of the App Store (a notification, a signed
 *   transaction or renewal info): ES256 by the leaf of its `x5c` chain, the
 *   leaf issued by the intermediate, the intermediate by a root we trust
 *   (Apple Root CA - G3; in development and tests also the local chain of
 *   `apps/api/fixtures/stores`), both certificates valid now and carrying
 *   Apple's markers (OID 1.2.840.113635.100.6.11.1 on the leaf, …6.2.1 on
 *   the intermediate). The root the JWS itself carries is not believed: the
 *   intermediate must verify against one of ours.
 * - `verifyRs256Jwt` — an OIDC token of Google (the Pub/Sub push): RS256 by a
 *   key named by its `kid`; the claims are the caller's to check.
 * - `signEs256Jwt`, `signRs256Jwt` — our own tokens to the stores' APIs.
 *
 * Every refusal is a `StoreSignatureError` whose message names what failed
 * and never carries the token or a part of it.
 */
export class StoreSignatureError extends Error {}

/** The marker of the App Store's signing certificate (the leaf). */
const APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1";
/** The marker of Apple's WWDR intermediate. */
const APPLE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/** The DER encoding of an OID (tag, length, content) — searched for in a certificate. */
export function oidDer(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...chunk);
  }
  return Buffer.from([0x06, bytes.length, ...bytes]);
}

const LEAF_MARKER = oidDer(APPLE_LEAF_OID);
const INTERMEDIATE_MARKER = oidDer(APPLE_INTERMEDIATE_OID);

function base64urlJson(part: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // below
  }
  throw new StoreSignatureError(`The ${what} is not JSON`);
}

function splitCompact(token: string, what: string): [string, string, string] {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new StoreSignatureError(`Not a compact ${what}`);
  }
  return parts as [string, string, string];
}

function validAt(certificate: X509Certificate, at: Date, what: string): void {
  const from = new Date(certificate.validFrom).getTime();
  const to = new Date(certificate.validTo).getTime();
  if (!(from <= at.getTime() && at.getTime() <= to)) {
    throw new StoreSignatureError(`The ${what} certificate is not valid now`);
  }
}

/** The trusted roots, parsed once. */
export function trustedRoots(pems: readonly string[]): X509Certificate[] {
  return pems.map((pem) => new X509Certificate(pem));
}

/**
 * Verifies a JWS of the App Store and returns its payload. `at` is the
 * moment the certificates must be valid at (now).
 */
export function verifyAppleJws(
  jws: string,
  roots: readonly X509Certificate[],
  at: Date,
): Record<string, unknown> {
  const [headerPart, payloadPart, signaturePart] = splitCompact(jws, "JWS");
  const header = base64urlJson(headerPart, "JWS header");
  if (header.alg !== "ES256") throw new StoreSignatureError("The JWS is not ES256");
  const x5c = header.x5c;
  if (
    !Array.isArray(x5c) ||
    x5c.length < 2 ||
    x5c.length > 3 ||
    !x5c.every((entry) => typeof entry === "string" && entry.length < 8192)
  ) {
    throw new StoreSignatureError("The JWS carries no certificate chain");
  }
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(Buffer.from(x5c[0] as string, "base64"));
    intermediate = new X509Certificate(Buffer.from(x5c[1] as string, "base64"));
  } catch {
    throw new StoreSignatureError("The JWS chain holds no certificates");
  }
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) {
    throw new StoreSignatureError("The leaf is not issued by the intermediate");
  }
  const root = roots.find(
    (candidate) => intermediate.checkIssued(candidate) && intermediate.verify(candidate.publicKey),
  );
  if (!root) throw new StoreSignatureError("The chain does not lead to a trusted root");
  if (!intermediate.ca) throw new StoreSignatureError("The intermediate is not a CA");
  validAt(leaf, at, "leaf");
  validAt(intermediate, at, "intermediate");
  validAt(root, at, "root");
  if (!leaf.raw.includes(LEAF_MARKER)) {
    throw new StoreSignatureError("The leaf is not an App Store signing certificate");
  }
  if (!intermediate.raw.includes(INTERMEDIATE_MARKER)) {
    throw new StoreSignatureError("The intermediate is not Apple's");
  }
  const signature = Buffer.from(signaturePart, "base64url");
  const good = verifySignature(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!good) throw new StoreSignatureError("The JWS signature does not match");
  return base64urlJson(payloadPart, "JWS payload");
}

/** Reads a JWS's payload without checking it — for a payload already checked as a whole. */
export function unverifiedPayload(jws: string): Record<string, unknown> {
  const [, payloadPart] = splitCompact(jws, "JWS");
  return base64urlJson(payloadPart, "JWS payload");
}

/**
 * Verifies an RS256 JWT with the key its `kid` names; returns its claims.
 * `exp`/`iat` are checked here (with `skewSeconds`), the rest is the caller's.
 */
export function verifyRs256Jwt(
  token: string,
  keyOf: (kid: string) => KeyObject | undefined,
  nowS: number,
  skewSeconds = 60,
): Record<string, unknown> {
  const [headerPart, payloadPart, signaturePart] = splitCompact(token, "JWT");
  const header = base64urlJson(headerPart, "JWT header");
  if (header.alg !== "RS256") throw new StoreSignatureError("The token is not RS256");
  const key = typeof header.kid === "string" ? keyOf(header.kid) : undefined;
  if (!key) throw new StoreSignatureError("The token's key is unknown");
  const good = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!good) throw new StoreSignatureError("The token's signature does not match");
  const claims = base64urlJson(payloadPart, "JWT claims");
  if (typeof claims.exp !== "number" || claims.exp + skewSeconds < nowS) {
    throw new StoreSignatureError("The token has expired");
  }
  if (typeof claims.iat === "number" && claims.iat - skewSeconds > nowS) {
    throw new StoreSignatureError("The token is from the future");
  }
  return claims;
}

function compact(header: object, claims: object): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode(header)}.${encode(claims)}`;
}

/** An ES256 JWT (or JWS) signed with a P-256 key in PEM. */
export function signEs256Jwt(header: object, claims: object, privateKeyPem: string): string {
  const input = compact({ alg: "ES256", ...header }, claims);
  const signer = createSign("SHA256");
  signer.update(input);
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

/** An RS256 JWT signed with an RSA key in PEM. */
export function signRs256Jwt(header: object, claims: object, privateKeyPem: string): string {
  const input = compact({ alg: "RS256", typ: "JWT", ...header }, claims);
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  return `${input}.${signer.sign(privateKeyPem).toString("base64url")}`;
}
