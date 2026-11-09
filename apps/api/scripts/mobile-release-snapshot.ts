import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compareVersions,
  readSupported,
  snapshotFileOf,
  snapshotProblems,
  SNAPSHOTS_DIR,
  SUPPORTED_FILE,
  supportedVersionSchema,
  type SupportedVersion,
} from "../src/contract-snapshots/contract-snapshots";

/**
 * The contract snapshot of a mobile release (ARCHITECTURE 7.2, 4.81;
 * TASK-056): copies `apps/api/openapi.json` as it is now to
 * `contract-snapshots/mobile/<version>.openapi.json` and adds the version to
 * `supported.json`. From then on CI keeps the server compatible with it.
 *
 * Usage (from the repository root):
 *   pnpm release:mobile:snapshot <version> [--released-on YYYY-MM-DD] [--platforms ios,android]
 *
 * The version must be the one in `apps/mobile/app.json` — the snapshot is of
 * the release being cut — and higher than every version already listed. Run
 * `pnpm --filter @adclub/api openapi:check` first: the snapshot is of the
 * document in the repository.
 */

const repoRoot = resolve(__dirname, "..", "..", "..");
const SPEC = join(repoRoot, "apps", "api", "openapi.json");
const APP_JSON = join(repoRoot, "apps", "mobile", "app.json");

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** Today in Almaty, `YYYY-MM-DD`. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
}

function main(argv: string[]): number {
  // The version is the first argument that is not a flag nor a flag's value.
  const flagValues = new Set(
    ["--released-on", "--platforms"].map((flag) => argv.indexOf(flag) + 1).filter((at) => at > 0),
  );
  const version = argv.find(
    (arg, at) => !arg.startsWith("--") && !flagValues.has(at) && /^\d+\.\d+\.\d+$/.test(arg),
  );
  if (!version) {
    console.error(
      "Usage: release:mobile:snapshot <version> [--released-on YYYY-MM-DD] [--platforms ios,android]",
    );
    return 1;
  }
  const appVersion = (JSON.parse(readFileSync(APP_JSON, "utf8")) as { expo: { version: string } })
    .expo.version;
  if (appVersion !== version) {
    console.error(
      `apps/mobile/app.json has version ${appVersion}, not ${version}: raise "version" first (ARCHITECTURE 4.81).`,
    );
    return 1;
  }
  const list = readSupported();
  const last = list.versions.at(-1);
  if (list.versions.some((entry) => entry.version === version)) {
    console.error(`${version} already has a snapshot.`);
    return 1;
  }
  if (last && compareVersions(last.version, version) >= 0) {
    console.error(`${version} is not higher than the last supported version ${last.version}.`);
    return 1;
  }
  const platforms = (option(argv, "--platforms") ?? "ios,android")
    .split(",")
    .map((platform) => platform.trim());
  const parsed = supportedVersionSchema.safeParse({
    version,
    releasedOn: option(argv, "--released-on") ?? today(),
    platforms,
  });
  if (!parsed.success) {
    console.error(
      `Not a release: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );
    return 1;
  }
  const entry: SupportedVersion = parsed.data;
  const target = join(SNAPSHOTS_DIR, snapshotFileOf(version));
  if (existsSync(target)) {
    console.error(`${snapshotFileOf(version)} already exists.`);
    return 1;
  }
  copyFileSync(SPEC, target);
  writeFileSync(
    join(SNAPSHOTS_DIR, SUPPORTED_FILE),
    `${JSON.stringify({ versions: [...list.versions, entry] }, null, 2)}\n`,
  );
  const problems = snapshotProblems();
  if (problems.length > 0) {
    console.error(`The snapshot folder is not consistent:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }
  console.log(
    `Snapshot ${snapshotFileOf(version)} written; ${SUPPORTED_FILE} lists ${String(list.versions.length + 1)} version(s). Commit both.`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
