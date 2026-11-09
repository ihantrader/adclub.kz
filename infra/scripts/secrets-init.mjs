// Secrets of a deployed environment (TASK-055; ARCHITECTURE 4.82): generated
// at random and encrypted with sops + age at once. No value is ever printed,
// logged or written unencrypted to disk — the plain text exists only in this
// process's memory and the pipe into sops.
//
//   node infra/scripts/secrets-init.mjs keys --out <dir>
//       two age key pairs — the Product Owner's and CI's: the private keys
//       into <dir>/owner.key and <dir>/ci.key (mode 600), the public keys
//       into .sops.yaml (the recipients of infra/secrets/staging.env.sops)
//
//   node infra/scripts/secrets-init.mjs staging [--force]
//       infra/secrets/staging.env.sops for the recipients of .sops.yaml; the
//       values the provider gives (S3 keys, the OpenRouter key of staging,
//       the monitoring DSN) are left empty — set them with `sops edit`
//
//   node infra/scripts/secrets-init.mjs rehearsal [--force]
//       .dev-staging/rehearsal.env.sops and its own key .dev-staging/age.key
//       (git-ignored) for the rehearsal on this machine, MinIO keys included
//
// sops and age run in the `ops` image (infra/docker/ops.Dockerfile; option
// --ops-image, default adclub-ops:local), so nothing has to be installed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const opsImage = option("--ops-image") ?? "adclub-ops:local";
const force = args.includes("--force");

function fail(message) {
  console.error(`secrets-init: ${message}`);
  process.exit(1);
}

/** Runs a tool of the ops image; stdout is returned, never printed. */
function tool(entrypoint, toolArgs, { input, env } = {}) {
  const dockerArgs = ["run", "--rm", "-i", "--entrypoint", entrypoint];
  for (const name of Object.keys(env ?? {})) dockerArgs.push("-e", name);
  dockerArgs.push("-v", `${root}:/w:ro`, "-w", "/w", opsImage, ...toolArgs);
  const result = spawnSync("docker", dockerArgs, {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // sops and age-keygen never echo key material in their errors.
    fail(`${entrypoint} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout;
}

function ageKeyPair() {
  const text = tool("age-keygen", []);
  const publicKey = /# public key: (age1[0-9a-z]+)/.exec(text)?.[1];
  const privateKey = /^(AGE-SECRET-KEY-1[0-9A-Z]+)$/m.exec(text)?.[1];
  if (!publicKey || !privateKey) fail("age-keygen gave no key pair");
  return { publicKey, privateKey };
}

const secret = (bytes) => randomBytes(bytes).toString("base64url");
const password = (bytes) => randomBytes(bytes).toString("hex");

/** The generated secrets every deployed environment has. */
function generated() {
  const postgres = password(24);
  const redis = password(24);
  return {
    POSTGRES_PASSWORD: postgres,
    DATABASE_URL: `postgres://adclub:${postgres}@postgres:5432/adclub`,
    REDIS_PASSWORD: redis,
    REDIS_URL: `redis://:${redis}@redis:6379`,
    MEILI_MASTER_KEY: secret(32),
    SESSION_TOKEN_SECRET: secret(48),
    LOGIN_CODE_HASH_SECRET: secret(48),
    ADMIN_TOTP_ENCRYPTION_KEY: secret(48),
    PAYMENT_TOKEN_ENCRYPTION_KEY: secret(48),
    PAYMENT_WEBHOOK_SECRET: secret(32),
    METRICS_TOKEN: secret(32),
  };
}

function dotenv(values, header) {
  return [
    ...header.map((line) => `# ${line}`),
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");
}

function writeEncrypted(target, plain, sopsArgs, env) {
  if (existsSync(target) && !force) {
    fail(
      `${target} exists; --force regenerates EVERY secret (sessions end, codes and second factors are reset — ARCHITECTURE 4.82)`,
    );
  }
  const encrypted = tool(
    "sops",
    ["--encrypt", "--input-type", "dotenv", "--output-type", "dotenv", ...sopsArgs, "/dev/stdin"],
    { input: plain, env },
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encrypted);
}

switch (command) {
  case "keys": {
    const out = option("--out");
    if (!out) fail("keys --out <dir>");
    mkdirSync(out, { recursive: true });
    const owner = ageKeyPair();
    const ci = ageKeyPair();
    for (const [name, pair] of [
      ["owner.key", owner],
      ["ci.key", ci],
    ]) {
      const file = join(out, name);
      writeFileSync(file, `${pair.privateKey}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    writeFileSync(
      join(root, ".sops.yaml"),
      [
        "# Who can decrypt the secrets of the deployed environments (TASK-055;",
        "# ARCHITECTURE 4.82): public age keys only. The private keys: the Product",
        "# Owner's — in their password manager; CI's — the GitHub secret SOPS_AGE_KEY.",
        "# After a change of the recipients: sops updatekeys infra/secrets/staging.env.sops",
        "creation_rules:",
        "  - path_regex: infra/secrets/staging\\.env\\.sops$",
        "    age: >-",
        `      ${owner.publicKey},`,
        `      ${ci.publicKey}`,
        "",
      ].join("\n"),
    );
    console.log(`secrets-init: .sops.yaml — owner ${owner.publicKey}, ci ${ci.publicKey}`);
    console.log(`secrets-init: private keys written to ${out} (owner.key, ci.key), mode 600`);
    break;
  }
  case "staging": {
    if (!existsSync(join(root, ".sops.yaml"))) fail("no .sops.yaml: run `keys` first");
    const values = {
      ...generated(),
      // Given by the provider with the buckets (part B).
      S3_ACCESS_KEY: "",
      S3_SECRET_KEY: "",
      // Empty: the files bucket's keys are used for the backups bucket too.
      BACKUP_S3_ACCESS_KEY: "",
      BACKUP_S3_SECRET_KEY: "",
      // A key of its own for staging, with a small ai_daily_budget_usd.
      OPENROUTER_API_KEY: "",
      MONITORING_DSN: "",
    };
    writeEncrypted(
      join(root, "infra", "secrets", "staging.env.sops"),
      dotenv(values, [
        "Staging secrets (TASK-055). Edit: sops edit infra/secrets/staging.env.sops",
      ]),
      ["--filename-override", "infra/secrets/staging.env.sops"],
    );
    console.log(
      `secrets-init: infra/secrets/staging.env.sops — ${Object.keys(values).length} variables, encrypted`,
    );
    break;
  }
  case "rehearsal": {
    const dir = join(root, ".dev-staging");
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, "age.key");
    let publicKey;
    if (existsSync(keyFile) && !force) {
      const privateKey = readFileSync(keyFile, "utf8").trim();
      publicKey = tool("age-keygen", ["-y"], { input: `${privateKey}\n` }).trim();
    } else {
      const pair = ageKeyPair();
      writeFileSync(keyFile, `${pair.privateKey}\n`, { mode: 0o600 });
      publicKey = pair.publicKey;
    }
    const values = {
      ...generated(),
      S3_ACCESS_KEY: password(10),
      S3_SECRET_KEY: secret(30),
      OPENROUTER_API_KEY: "",
    };
    writeEncrypted(
      join(dir, "rehearsal.env.sops"),
      dotenv(values, ["Rehearsal secrets of this machine (TASK-055); git-ignored"]),
      ["--age", publicKey],
    );
    console.log(
      `secrets-init: .dev-staging/rehearsal.env.sops — ${Object.keys(values).length} variables, encrypted for ${publicKey}`,
    );
    break;
  }
  default:
    fail("usage: secrets-init.mjs keys --out <dir> | staging [--force] | rehearsal [--force]");
}
