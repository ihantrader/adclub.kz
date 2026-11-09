import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  readSupported,
  snapshotFileOf,
  snapshotProblems,
  SNAPSHOTS_DIR,
} from "../src/contract-snapshots/contract-snapshots";

/**
 * Backward-compatibility gate for the API contract (ARCHITECTURE 7.2, 7.4,
 * 4.81; TASK-003, TASK-056): compares `apps/api/openapi.json` in the working
 * tree with a base document and fails on a breaking change — removed route
 * or response field, changed type, new required input.
 *
 * Usage: tsx scripts/check-openapi-compat.ts
 *   [--base <git-rev>]           the same file at a git revision (default: origin/main) —
 *                                catches a break inside one app version;
 *   [--base-file <path>]         a document on disk, e.g. one contract snapshot;
 *   [--snapshots]                every snapshot of a supported app version
 *                                (`contract-snapshots/mobile/supported.json`), one after another;
 *   [--trailers-since <git-rev>] with --base-file / --snapshots: where the commits that
 *                                may acknowledge a break start (CI: the pushed range).
 *
 * The diff itself is oasdiff (pinned Docker image). Its default levels
 * are tightened/relaxed by `openapi-compat-levels.txt` (the format allows
 * no comments, so the reasons live here):
 * - `response-optional-property-removed ERR`: an old client may read an
 *   optional field too; removing it is only allowed once no supported
 *   version uses it — that's a deliberate breaking change (below);
 * - `response-property-enum-value-added INFO`: clients must treat unknown
 *   enum values as "other" (ARCHITECTURE 7.4), so adding one (a status,
 *   an error code) is additive.
 *
 * Deliberate breaking change: add the trailer
 *   Contract-Breaking-Change: <why it is safe / which versions are affected>
 * to a commit message between the base and HEAD (for a snapshot: between
 * `--trailers-since` and HEAD). The check then reports the changes but
 * passes. The preferred alternative is a new path (`/v2/...`, ARCHITECTURE
 * 7.4); a break against a snapshot means a published app version breaks —
 * acknowledge it only when no person can still run that version.
 */

const OASDIFF_IMAGE = "tufin/oasdiff:v1.32.1";
const SPEC_REPO_PATH = "apps/api/openapi.json";
const TRAILER = "Contract-Breaking-Change";
const repoRoot = resolve(__dirname, "..", "..", "..");

type Verdict = "compatible" | "acknowledged" | "breaking" | "error";

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  // The document outgrew the 1 MB default of `maxBuffer` (TASK-057): `git show`
  // of it then failed, and a failure read as «no document at the base» — the
  // check skipped itself without a word. Room for the document to keep growing.
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

/** The reasons of `Contract-Breaking-Change` trailers in `<since>..HEAD`. */
function acknowledgementsSince(since: string | undefined): string[] {
  if (!since) return [];
  if (git(["rev-parse", "--verify", "--quiet", `${since}^{commit}`]).status !== 0) {
    console.warn(`Revision "${since}" not found: no commit can acknowledge a break.`);
    return [];
  }
  return git(["log", `${since}..HEAD`, `--format=%(trailers:key=${TRAILER},valueonly)`])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** One comparison of the working tree's document with `baseText`. */
function compare(baseText: string, label: string, trailersSince: string | undefined): Verdict {
  const workDir = mkdtempSync(join(tmpdir(), "openapi-compat-"));
  try {
    writeFileSync(join(workDir, "base.json"), baseText);
    copyFileSync(join(repoRoot, SPEC_REPO_PATH), join(workDir, "revision.json"));
    copyFileSync(
      resolve(__dirname, "..", "openapi-compat-levels.txt"),
      join(workDir, "levels.txt"),
    );

    const diff = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${workDir}:/specs:ro`,
        OASDIFF_IMAGE,
        "breaking",
        "/specs/base.json",
        "/specs/revision.json",
        "--fail-on",
        "ERR",
        "--severity-levels",
        "/specs/levels.txt",
        "--color",
        "never",
      ],
      { encoding: "utf8" },
    );

    process.stdout.write(diff.stdout ?? "");
    process.stderr.write(diff.stderr ?? "");

    if (diff.error) {
      console.error(`Could not run oasdiff via Docker: ${diff.error.message}`);
      return "error";
    }
    if (diff.status === 0) {
      console.log(`Contract is backward compatible with ${label}.`);
      return "compatible";
    }
    if (diff.status !== 1) {
      console.error(`oasdiff failed with exit code ${String(diff.status)}.`);
      return "error";
    }

    const acknowledgements = acknowledgementsSince(trailersSince);
    if (acknowledgements.length > 0) {
      console.warn(`Breaking contract change against ${label} acknowledged via "${TRAILER}":`);
      for (const reason of acknowledgements) {
        console.warn(`  - ${reason}`);
      }
      return "acknowledged";
    }
    console.error(
      [
        `Breaking API contract change against ${label} (see above).`,
        "Old mobile app versions would break. Make the change additive, or add a new path (/v2/...).",
        `If the break is deliberate and safe, add a "${TRAILER}: <reason>" trailer to the commit message (ARCHITECTURE 4.4).`,
      ].join("\n"),
    );
    return "breaking";
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function againstRevision(base: string): number {
  if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
    console.error(
      `Base revision "${base}" not found (is the history fetched? CI needs fetch-depth: 0).`,
    );
    return 1;
  }
  const baseSpec = git(["show", `${base}:${SPEC_REPO_PATH}`]);
  if (baseSpec.status !== 0) {
    console.log(
      `${SPEC_REPO_PATH} does not exist at ${base}: nothing to compare against, skipping.`,
    );
    return 0;
  }
  const verdict = compare(baseSpec.stdout, base, base);
  return verdict === "compatible" || verdict === "acknowledged" ? 0 : 1;
}

function againstFile(path: string, label: string, trailersSince: string | undefined): Verdict {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`Cannot read the base document ${path}.`);
    return "error";
  }
  return compare(text, label, trailersSince);
}

/** Every supported app version: the server must keep each of them working. */
function againstSnapshots(trailersSince: string | undefined): number {
  const problems = snapshotProblems();
  if (problems.length > 0) {
    console.error(`The contract snapshots are not consistent:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }
  const { versions } = readSupported();
  if (versions.length === 0) {
    console.log("No app version is published yet: no snapshot to compare against.");
    return 0;
  }
  const failed: string[] = [];
  for (const { version } of versions) {
    console.log(`\n== Mobile app ${version} (contract snapshot) ==`);
    const verdict = againstFile(
      join(SNAPSHOTS_DIR, snapshotFileOf(version)),
      `the contract snapshot of mobile ${version}`,
      trailersSince,
    );
    if (verdict === "breaking" || verdict === "error") failed.push(version);
    if (verdict === "acknowledged") {
      // A snapshot never moves on, unlike a base revision: the trailer covers
      // only the push it is in, and the next push is red again.
      console.warn(
        `The acknowledgement covers this push only: the snapshot of ${version} stays. Remove ${version} from supported.json (allowed once client_min_version_* of both platforms passed it, ARCHITECTURE 4.81 I886) before the next push, or make the server compatible again.`,
      );
    }
  }
  if (failed.length > 0) {
    console.error(`\nThe server breaks published app version(s): ${failed.join(", ")}.`);
    return 1;
  }
  console.log(
    `\nCompatible with every supported app version: ${versions.map((v) => v.version).join(", ")}.`,
  );
  return 0;
}

function main(): number {
  const argv = process.argv.slice(2);
  const trailersSince = option(argv, "--trailers-since");
  if (argv.includes("--snapshots")) {
    return againstSnapshots(trailersSince);
  }
  const baseFile = option(argv, "--base-file");
  if (baseFile) {
    const path = resolve(process.cwd(), baseFile);
    const verdict = againstFile(path, relative(repoRoot, path), trailersSince);
    return verdict === "compatible" || verdict === "acknowledged" ? 0 : 1;
  }
  return againstRevision(option(argv, "--base") ?? "origin/main");
}

process.exitCode = main();
