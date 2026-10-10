import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import weights from "./integration-weights.json";

/**
 * Splits the integration test files into the parts CI runs in parallel
 * (TASK-076). Every file belongs to exactly one part: the parts are computed
 * from the files found on disk, never from a list someone has to keep in
 * step, so a new file lands in a part by itself.
 *
 * The split is by expected duration (`integration-weights.json`, seconds):
 * the longest file goes to the lightest part so far. A file without a weight
 * counts as `UNKNOWN_FILE_SECONDS`, which puts a new file where it does the
 * least harm until its weight is written down.
 */

const SUFFIX = ".integration.test.ts";

/** What a file nobody has timed yet is assumed to take. */
export const UNKNOWN_FILE_SECONDS = 60;

/** Paths relative to `apps/api`, with `/`, sorted. */
export function listIntegrationFiles(apiRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(SUFFIX)) {
        found.push(relative(apiRoot, path).split("\\").join("/"));
      }
    }
  };
  walk(join(apiRoot, "src"));
  return found.sort();
}

export function fileWeight(
  file: string,
  known: Readonly<Record<string, number>> = weights,
): number {
  return known[file] ?? UNKNOWN_FILE_SECONDS;
}

/** `count` parts, each a sorted list of files; the parts together are exactly `files`. */
export function planShards(
  files: readonly string[],
  count: number,
  known: Readonly<Record<string, number>> = weights,
): string[][] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`The number of parts must be a positive integer, got ${count}`);
  }
  const parts = Array.from({ length: count }, () => ({ files: [] as string[], load: 0 }));
  const ordered = [...files].sort(
    (a, b) => fileWeight(b, known) - fileWeight(a, known) || a.localeCompare(b),
  );
  for (const file of ordered) {
    let lightest = parts[0]!;
    for (const part of parts) {
      if (part.load < lightest.load) {
        lightest = part;
      }
    }
    lightest.files.push(file);
    lightest.load += fileWeight(file, known);
  }
  return parts.map((part) => part.files.sort());
}

export function shardLoad(
  files: readonly string[],
  known: Readonly<Record<string, number>> = weights,
): number {
  return files.reduce((sum, file) => sum + fileWeight(file, known), 0);
}

/** Files that are missing from the parts or are in more than one. Empty when the split is whole. */
export function partitionProblems(files: readonly string[], parts: readonly string[][]): string[] {
  const seen = new Map<string, number>();
  for (const part of parts) {
    for (const file of part) {
      seen.set(file, (seen.get(file) ?? 0) + 1);
    }
  }
  const problems: string[] = [];
  for (const file of files) {
    const times = seen.get(file) ?? 0;
    if (times !== 1) {
      problems.push(`${file} is in ${times} parts`);
    }
  }
  for (const file of seen.keys()) {
    if (!files.includes(file)) {
      problems.push(`${file} is in a part but is not an integration test file`);
    }
  }
  return problems;
}

/** `"2/5"` → `{ index: 2, count: 5 }` (parts count from 1, like the CI matrix). */
export function parseShard(text: string): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const index = match ? Number(match[1]) : 0;
  const count = match ? Number(match[2]) : 0;
  if (!match || index < 1 || count < 1 || index > count) {
    throw new Error(`Expected a part as "<index>/<count>", counting from 1, got "${text}"`);
  }
  return { index, count };
}
