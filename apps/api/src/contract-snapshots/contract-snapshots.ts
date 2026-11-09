import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * The contract snapshots of published app versions (ARCHITECTURE 7.2, 4.81;
 * TASK-056): for every version of the mobile app still served, the API
 * document (`apps/api/openapi.json`) as it was when that version was
 * released. CI compares the server with each of them
 * (`openapi:compat --snapshots`) — the server must keep every supported
 * version working, not only the last `main`.
 *
 * The list of supported versions (`supported.json`) is written by the
 * release command (`pnpm release:mobile:snapshot <version>`); a version
 * leaves it only after `client_min_version_*` of both platforms has passed
 * it (the procedure — ARCHITECTURE 4.81).
 */

export const SNAPSHOTS_DIR = resolve(__dirname, "..", "..", "contract-snapshots", "mobile");
export const SUPPORTED_FILE = "supported.json";
export const SNAPSHOT_SUFFIX = ".openapi.json";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const supportedVersionSchema = z.object({
  version: z.string().regex(SEMVER),
  /** The day the version went to the stores (or to internal testing), `YYYY-MM-DD`. */
  releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  platforms: z.array(z.enum(["ios", "android"])).min(1),
});

export const supportedListSchema = z.object({
  versions: z.array(supportedVersionSchema),
});

export type SupportedVersion = z.infer<typeof supportedVersionSchema>;
export type SupportedList = z.infer<typeof supportedListSchema>;

export function snapshotFileOf(version: string): string {
  return `${version}${SNAPSHOT_SUFFIX}`;
}

/** `-1`, `0`, `1` — the order of two `MAJOR.MINOR.PATCH` versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function readSupported(dir = SNAPSHOTS_DIR): SupportedList {
  const raw = JSON.parse(readFileSync(join(dir, SUPPORTED_FILE), "utf8")) as unknown;
  return supportedListSchema.parse(raw);
}

/**
 * What is wrong with the folder: a listed version without its snapshot, a
 * snapshot nobody lists, versions out of order or repeated, a snapshot that
 * is not an OpenAPI document. Empty — consistent.
 */
export function snapshotProblems(dir = SNAPSHOTS_DIR): string[] {
  const problems: string[] = [];
  let list: SupportedList;
  try {
    list = readSupported(dir);
  } catch (error) {
    return [`${SUPPORTED_FILE} is unreadable: ${error instanceof Error ? error.message : "?"}`];
  }
  const listed = new Set<string>();
  list.versions.forEach((entry, index) => {
    if (listed.has(entry.version)) problems.push(`${entry.version} is listed twice`);
    listed.add(entry.version);
    const previous = list.versions[index - 1];
    if (previous && compareVersions(previous.version, entry.version) >= 0) {
      problems.push(`${entry.version} comes after ${previous.version}: versions must increase`);
    }
    const file = join(dir, snapshotFileOf(entry.version));
    if (!existsSync(file)) {
      problems.push(`${entry.version} has no snapshot ${snapshotFileOf(entry.version)}`);
      return;
    }
    try {
      const document = JSON.parse(readFileSync(file, "utf8")) as { openapi?: unknown };
      if (typeof document.openapi !== "string") {
        problems.push(`${snapshotFileOf(entry.version)} is not an OpenAPI document`);
      }
    } catch {
      problems.push(`${snapshotFileOf(entry.version)} is not JSON`);
    }
  });
  for (const name of readdirSync(dir)) {
    if (name === SUPPORTED_FILE) continue;
    if (!name.endsWith(SNAPSHOT_SUFFIX)) {
      problems.push(`${name} does not belong in the snapshot folder`);
      continue;
    }
    const version = name.slice(0, -SNAPSHOT_SUFFIX.length);
    if (!listed.has(version)) problems.push(`${name} is not in ${SUPPORTED_FILE}`);
  }
  return problems;
}
