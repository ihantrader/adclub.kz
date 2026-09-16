import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Backward-compatibility gate for the API contract (ARCHITECTURE 7.4,
 * TASK-003): compares `apps/api/openapi.json` in the working tree with the
 * same file at a base git revision and fails on a breaking change —
 * removed route or response field, changed type, new required input.
 *
 * Usage: tsx scripts/check-openapi-compat.ts [--base <git-rev>]  (default: origin/main)
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
 * to a commit message between the base and HEAD. The check then reports
 * the changes but passes. The preferred alternative is a new path
 * (`/v2/...`, ARCHITECTURE 7.4).
 */

const OASDIFF_IMAGE = "tufin/oasdiff:v1.32.1";
const SPEC_REPO_PATH = "apps/api/openapi.json";
const TRAILER = "Contract-Breaking-Change";
const repoRoot = resolve(__dirname, "..", "..", "..");

function git(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function parseBase(argv: string[]): string {
  const index = argv.indexOf("--base");
  if (index === -1) {
    return "origin/main";
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error("--base needs a git revision");
  }
  return value;
}

function main(): number {
  const base = parseBase(process.argv.slice(2));

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

  const workDir = mkdtempSync(join(tmpdir(), "openapi-compat-"));
  try {
    writeFileSync(join(workDir, "base.json"), baseSpec.stdout);
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
      return 1;
    }
    if (diff.status === 0) {
      console.log(`Contract is backward compatible with ${base}.`);
      return 0;
    }
    if (diff.status !== 1) {
      console.error(`oasdiff failed with exit code ${String(diff.status)}.`);
      return 1;
    }

    const acknowledgements = git([
      "log",
      `${base}..HEAD`,
      `--format=%(trailers:key=${TRAILER},valueonly)`,
    ])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (acknowledgements.length > 0) {
      console.warn(`Breaking contract change acknowledged via "${TRAILER}":`);
      for (const reason of acknowledgements) {
        console.warn(`  - ${reason}`);
      }
      return 0;
    }

    console.error(
      [
        `Breaking API contract change against ${base} (see above).`,
        "Old mobile app versions would break. Make the change additive, or add a new path (/v2/...).",
        `If the break is deliberate and safe, add a "${TRAILER}: <reason>" trailer to the commit message (ARCHITECTURE 4.4).`,
      ].join("\n"),
    );
    return 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
