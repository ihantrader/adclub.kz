import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareVersions,
  mobileContractOf,
  mobileOperations,
  mobileSnapshotText,
  readSupported,
  snapshotFileOf,
  snapshotProblems,
  SNAPSHOTS_DIR,
  SUPPORTED_FILE,
} from "./contract-snapshots";

/**
 * The contract snapshots of published app versions (TASK-056 AC-5): every
 * listed version has its snapshot, every snapshot is listed, versions grow;
 * a snapshot holds only what the app can call (I894).
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

describe("the mobile part of the contract (I894)", () => {
  it("keeps the routes of guests and users, not those of the cabinet, the admin panel and the web sign-in", () => {
    const operations = mobileOperations();
    expect(operations).toContain("GET /catalog/categories");
    expect(operations).toContain("POST /orders");
    expect(operations).toContain("GET /meta/client-policy");
    expect(operations).toContain("POST /auth/login-code/verify");
    expect(operations).toContain("GET /auth/me");
    expect([...operations].filter((op) => op.includes(" /admin/"))).toEqual([]);
    expect([...operations].filter((op) => op.includes(" /supplier/"))).toEqual([]);
    expect([...operations].filter((op) => op.includes(" /auth/sign-in/"))).toEqual([]);
    expect(operations).not.toContain("POST /supplier-leads");
  });

  it("drops the operations the app cannot call and the components only they reference", () => {
    const document = {
      openapi: "3.1.0",
      paths: {
        "/catalog/categories": {
          get: { responses: { 200: { $ref: "#/components/responses/Tree" } } },
          parameters: [{ $ref: "#/components/parameters/Lang" }],
        },
        "/admin/catalog/categories": {
          get: { responses: { 200: { $ref: "#/components/responses/AdminTree" } } },
          post: { responses: { 201: { $ref: "#/components/responses/AdminTree" } } },
        },
        "/orders": {
          post: { responses: { 201: { $ref: "#/components/schemas/Order" } } },
          // Not a route of the contract: dropped with its path.
          put: { responses: {} },
        },
      },
      components: {
        schemas: {
          Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } },
          Order: { type: "object", properties: { node: { $ref: "#/components/schemas/Node" } } },
          AdminNode: { type: "object" },
          Unused: { type: "object" },
        },
        responses: {
          Tree: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
          },
          AdminTree: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/AdminNode" } } },
          },
        },
        parameters: { Lang: { name: "Accept-Language", in: "header" } },
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      },
    };
    const reduced = mobileContractOf(document);
    expect(Object.keys(reduced.paths)).toEqual(["/catalog/categories", "/orders"]);
    expect(Object.keys(reduced.paths["/catalog/categories"])).toEqual(["get", "parameters"]);
    expect(Object.keys(reduced.paths["/orders"])).toEqual(["post"]);
    expect(Object.keys(reduced.components.schemas)).toEqual(["Node", "Order"]);
    expect(Object.keys(reduced.components.responses)).toEqual(["Tree"]);
    expect(Object.keys(reduced.components.parameters)).toEqual(["Lang"]);
    expect(reduced.components.securitySchemes).toEqual(document.components.securitySchemes);
    // The input is left alone.
    expect(Object.keys(document.paths)).toHaveLength(3);
  });

  it("the committed snapshots hold the mobile part only, and the current document reduces to a superset of 1.0.0's paths", () => {
    const current = JSON.parse(
      readFileSync(resolve(SNAPSHOTS_DIR, "..", "..", "openapi.json"), "utf8"),
    ) as Record<string, unknown>;
    const reduced = mobileContractOf(current);
    const reducedPaths = Object.keys(reduced.paths as object);
    expect(reducedPaths.some((path) => path.startsWith("/admin/"))).toBe(false);
    expect(reducedPaths.some((path) => path.startsWith("/supplier/"))).toBe(false);
    for (const { version } of readSupported().versions) {
      const snapshot = JSON.parse(
        readFileSync(resolve(SNAPSHOTS_DIR, snapshotFileOf(version)), "utf8"),
      ) as { paths: Record<string, unknown> };
      const snapshotPaths = Object.keys(snapshot.paths);
      expect(snapshotPaths.some((path) => path.startsWith("/admin/"))).toBe(false);
      // Removing a route is a breaking change oasdiff reports; the list test is cheaper to read.
      for (const path of snapshotPaths) expect(reducedPaths).toContain(path);
    }
    // The text of a snapshot is deterministic.
    const text = JSON.stringify(current);
    expect(mobileSnapshotText(text)).toBe(mobileSnapshotText(text));
    expect(mobileSnapshotText(text).endsWith("}\n")).toBe(true);
  });
});
