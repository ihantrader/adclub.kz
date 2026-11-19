#!/usr/bin/env node
/**
 * The local stand-ins of the stores' signatures (TASK-041, ARCHITECTURE 4.98):
 * `apps/api/fixtures/stores/`.
 *
 * - a development chain like Apple's — a root, an intermediate with Apple's
 *   intermediate marker (OID 1.2.840.113635.100.6.2.1) and a leaf with the
 *   marker of the App Store's signing certificate (1.2.840.113635.100.6.11.1),
 *   EC P-256 like Apple's; the leaf's key signs the JWS of the tests and of
 *   `dev:stores:notify`; the server trusts this root **only in development
 *   and tests** (beside Apple Root CA - G3, which it always trusts);
 * - the same leaf expired (its validity is over) — «a stale signature»;
 * - a rogue chain of the same shape that nothing trusts — «a forged one»;
 * - an RSA key that signs the OIDC tokens of the imitated Pub/Sub push of
 *   Google Play (development and tests only).
 *
 * Nothing here is a secret: the keys sign for the test stores only, and a
 * deployed server never trusts them. Run with `node scripts/store-test-certs.mjs`
 * (needs `openssl` 3.4 or newer — Git for Windows has it); the files are
 * committed, CI does not regenerate them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "..", "apps", "api", "fixtures", "stores");

function opensslPath() {
  for (const candidate of [
    "openssl",
    "C:/Program Files/Git/usr/bin/openssl.exe",
    "C:/Program Files/Git/mingw64/bin/openssl.exe",
  ]) {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error("openssl is not found");
}

const OPENSSL = opensslPath();
const work = mkdtempSync(join(tmpdir(), "store-certs-"));
const run = (...args) => execFileSync(OPENSSL, args, { cwd: work, stdio: "pipe" });

const EXT = join(work, "ext.cnf");
writeFileSync(
  EXT,
  [
    "[root]",
    "basicConstraints = critical, CA:true",
    "keyUsage = critical, keyCertSign, cRLSign",
    "subjectKeyIdentifier = hash",
    "[intermediate]",
    "basicConstraints = critical, CA:true, pathlen:0",
    "keyUsage = critical, keyCertSign, cRLSign",
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid",
    "1.2.840.113635.100.6.2.1 = ASN1:NULL",
    "[leaf]",
    "basicConstraints = critical, CA:false",
    "keyUsage = critical, digitalSignature",
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid",
    "1.2.840.113635.100.6.11.1 = ASN1:NULL",
    "",
  ].join("\n"),
);

const FROM = "20250101000000Z";
const TO = "20450101000000Z";

function ecKey(name) {
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.ec.key`);
  run("pkcs8", "-topk8", "-nocrypt", "-in", `${name}.ec.key`, "-out", `${name}.key`);
}

function selfSigned(name, subject) {
  ecKey(name);
  run("req", "-new", "-key", `${name}.key`, "-subj", subject, "-out", `${name}.csr`);
  run(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-signkey",
    `${name}.key`,
    "-not_before",
    FROM,
    "-not_after",
    TO,
    "-sha256",
    "-extfile",
    EXT,
    "-extensions",
    "root",
    "-out",
    `${name}.pem`,
  );
}

function issued(name, subject, issuer, section, from = FROM, to = TO, key = name) {
  if (key === name) ecKey(name);
  run("req", "-new", "-key", `${key}.key`, "-subj", subject, "-out", `${name}.csr`);
  run(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${issuer}.pem`,
    "-CAkey",
    `${issuer}.key`,
    "-set_serial",
    String(Math.floor(Math.random() * 1e9)),
    "-not_before",
    from,
    "-not_after",
    to,
    "-sha256",
    "-extfile",
    EXT,
    "-extensions",
    section,
    "-out",
    `${name}.pem`,
  );
}

function chain(prefix) {
  selfSigned(`${prefix}-root`, `/CN=${prefix} Root CA (development only)/O=adclub dev`);
  issued(
    `${prefix}-intermediate`,
    `/CN=${prefix} WWDR (development only)/O=adclub dev`,
    `${prefix}-root`,
    "intermediate",
  );
  issued(
    `${prefix}-leaf`,
    `/CN=${prefix} App Store signing (development only)/O=adclub dev`,
    `${prefix}-intermediate`,
    "leaf",
  );
}

try {
  chain("apple-dev");
  // The same key, a certificate whose validity is over.
  issued(
    "apple-dev-leaf-expired",
    "/CN=apple-dev App Store signing, expired (development only)/O=adclub dev",
    "apple-dev-intermediate",
    "leaf",
    "20200101000000Z",
    "20210101000000Z",
    "apple-dev-leaf",
  );
  chain("apple-rogue");
  run(
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
    "-out",
    "google-dev-oidc.key",
  );

  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const files = [
    "apple-dev-root.pem",
    "apple-dev-intermediate.pem",
    "apple-dev-leaf.pem",
    "apple-dev-leaf.key",
    "apple-dev-leaf-expired.pem",
    "apple-rogue-root.pem",
    "apple-rogue-intermediate.pem",
    "apple-rogue-leaf.pem",
    "apple-rogue-leaf.key",
    "google-dev-oidc.key",
  ];
  for (const file of files) {
    const text = readFileSync(join(work, file), "utf8");
    writeFileSync(join(OUT, file), text.replace(/\r\n/g, "\n"));
  }
  console.log(`Written ${String(files.length)} files to ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
