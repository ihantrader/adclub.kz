import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STORE_FIXTURES } from "./app-store";
import { DEV_OIDC_KID } from "./google-play";
import { signEs256Jwt, signRs256Jwt } from "./signatures";

/**
 * Signing as the stores do, with the local keys of `apps/api/fixtures/stores`
 * (TASK-041) — for `dev:stores:notify` and the tests only. The server trusts
 * these keys in development and tests alone (`devTrust` of the config); a
 * deployed server refuses everything signed here.
 */

function fixture(name: string): string {
  return readFileSync(resolve(STORE_FIXTURES, name), "utf8");
}

function der(pem: string): string {
  return new X509Certificate(pem).raw.toString("base64");
}

export type DevChain = "dev" | "expired" | "rogue";

/** A JWS like Apple's: ES256 by a leaf whose chain is in `x5c`. */
export function devAppleJws(payload: object, chain: DevChain = "dev"): string {
  const prefix = chain === "rogue" ? "apple-rogue" : "apple-dev";
  const leaf = chain === "expired" ? "apple-dev-leaf-expired.pem" : `${prefix}-leaf.pem`;
  const x5c = [
    der(fixture(leaf)),
    der(fixture(`${prefix}-intermediate.pem`)),
    der(fixture(`${prefix}-root.pem`)),
  ];
  return signEs256Jwt({ x5c }, payload, fixture(`${prefix}-leaf.key`));
}

/** An OIDC token like the one Pub/Sub push carries, by the local key (kid `adclub-dev`). */
export function devGoogleOidcToken(claims: object, kid = DEV_OIDC_KID): string {
  return signRs256Jwt({ kid }, claims, fixture("google-dev-oidc.key"));
}

/** The public half of the local OIDC key, as a JWK (a local «Google keys» server answers it). */
export function devGoogleOidcJwk(kid = DEV_OIDC_KID): Record<string, unknown> {
  const jwk = createPublicKey(createPrivateKey(fixture("google-dev-oidc.key"))).export({
    format: "jwk",
  });
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

/** A Pub/Sub push body around a developer notification. */
export function devPubsubPush(notification: object, messageId: string): Record<string, unknown> {
  return {
    message: {
      data: Buffer.from(JSON.stringify(notification), "utf8").toString("base64"),
      messageId,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/adclub-dev/subscriptions/play-rtdn",
  };
}
