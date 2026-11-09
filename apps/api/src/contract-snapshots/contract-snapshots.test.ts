import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  readSupported,
  snapshotFileOf,
  snapshotProblems,
  SUPPORTED_FILE,
} from "./contract-snapshots";

/**
 * The contract snapshots of published app versions (TASK-056 AC-5): every
 * listed version has its snapshot, every snapshot is listed, versions grow.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(versions: string[], files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "snapshots-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, SUPPORTED_FILE),
    JSON.stringify({
      versions: versions.map((version) => ({
        version,
        releasedOn: "2026-11-09",
        platforms: ["ios", "android"],
      })),
    }),
  );
  for (const file of files) writeFileSync(join(dir, file), JSON.stringify({ openapi: "3.1.0" }));
  return dir;
}

describe("contract snapshots (ARCHITECTURE 7.2, 4.81)", () => {
  it("the repository's folder is consistent and lists 1.0.0", () => {
    expect(snapshotProblems()).toEqual([]);
    expect(readSupported().versions.map((entry) => entry.version)).toContain("1.0.0");
  });

  it("finds a listed version without a snapshot and a snapshot nobody lists", () => {
    const dir = folder(["1.0.0", "1.1.0"], [snapshotFileOf("1.0.0"), snapshotFileOf("0.9.0")]);
    expect(snapshotProblems(dir)).toEqual([
      "1.1.0 has no snapshot 1.1.0.openapi.json",
      "0.9.0.openapi.json is not in supported.json",
    ]);
  });

  it("refuses versions that do not increase, repeats and strangers in the folder", () => {
    const dir = folder(
      ["1.2.0", "1.1.0", "1.1.0"],
      [snapshotFileOf("1.2.0"), snapshotFileOf("1.1.0"), "notes.txt"],
    );
    const problems = snapshotProblems(dir);
    expect(problems).toContain("1.1.0 comes after 1.2.0: versions must increase");
    expect(problems).toContain("1.1.0 is listed twice");
    expect(problems).toContain("notes.txt does not belong in the snapshot folder");
  });

  it("orders versions as numbers, not as text", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
  });
});
