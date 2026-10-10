import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_FILE_SECONDS,
  fileWeight,
  listIntegrationFiles,
  parseShard,
  partitionProblems,
  planShards,
  shardLoad,
} from "./integration-shards";
import weights from "./integration-weights.json";

const API_ROOT = resolve(__dirname, "../..");
const CI_WORKFLOW = resolve(API_ROOT, "../../.github/workflows/ci.yml");

describe("the parts of the integration tests CI runs in parallel", () => {
  const files = listIntegrationFiles(API_ROOT);

  it("finds the integration test files", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.every((file) => file.endsWith(".integration.test.ts"))).toBe(true);
    expect(files).toContain("src/database/database.integration.test.ts");
  });

  it("puts every file into exactly one part, for any number of parts", () => {
    for (let count = 1; count <= 12; count += 1) {
      const parts = planShards(files, count);
      expect(parts).toHaveLength(count);
      expect(partitionProblems(files, parts), `${count} parts`).toEqual([]);
    }
  });

  it("notices a file that is missing from the parts or is in two", () => {
    const parts = planShards(files, 4);
    const moved = parts[0]![0]!;
    expect(partitionProblems(files, [parts[0]!.slice(1), ...parts.slice(1)])).toEqual([
      `${moved} is in 0 parts`,
    ]);
    expect(partitionProblems(files, [...parts, [moved]])).toEqual([`${moved} is in 2 parts`]);
    expect(partitionProblems(files, [...parts, ["src/nowhere.integration.test.ts"]])).toEqual([
      "src/nowhere.integration.test.ts is in a part but is not an integration test file",
    ]);
  });

  it("puts a file nobody has timed into a part by itself", () => {
    const withNew = [...files, "src/modules/new/new.integration.test.ts"];
    const parts = planShards(withNew, 5);
    expect(partitionProblems(withNew, parts)).toEqual([]);
    expect(fileWeight("src/modules/new/new.integration.test.ts")).toBe(UNKNOWN_FILE_SECONDS);
  });

  it("splits by time: no part is much heavier than an even share, unless one file is", () => {
    for (const count of [3, 4, 5, 6]) {
      const loads = planShards(files, count).map((part) => shardLoad(part));
      const total = loads.reduce((a, b) => a + b, 0);
      const heaviestFile = Math.max(...files.map((file) => fileWeight(file)));
      expect(Math.max(...loads), `${count} parts`).toBeLessThanOrEqual(
        Math.max(heaviestFile, (total / count) * (4 / 3)),
      );
    }
  });

  it("has a weight only for files that exist, so the table does not rot", () => {
    expect(Object.keys(weights).filter((file) => !files.includes(file))).toEqual([]);
  });

  it("reads a part as <index>/<count> counting from 1", () => {
    expect(parseShard("2/5")).toEqual({ index: 2, count: 5 });
    for (const bad of ["0/5", "6/5", "x", "1/0", "2"]) {
      expect(() => parseShard(bad), bad).toThrow(/Expected a part/);
    }
  });

  it("is run by CI as a matrix of 1..N whose size is what every part divides by", () => {
    const workflow = readFileSync(CI_WORKFLOW, "utf8");
    const matrix = /^\s+shard:\s*\[([^\]]+)\]/m.exec(workflow);
    expect(matrix, "a `shard: [1, 2, …]` matrix in ci.yml").not.toBeNull();
    const indexes = matrix![1]!.split(",").map((item) => Number(item.trim()));
    expect(indexes).toEqual(indexes.map((_, position) => position + 1));
    // The count comes from the matrix itself, so a part cannot be dropped from it
    // without the others covering its files.
    expect(workflow).toContain("${{ matrix.shard }}/${{ strategy.job-total }}");
  });
});
