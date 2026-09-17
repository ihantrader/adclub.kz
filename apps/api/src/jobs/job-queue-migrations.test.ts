import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../database/migrate-cli";
import {
  installedJobQueueSchemaVersion,
  jobQueueSchemaMigration,
  migratedJobQueueSchemaVersion,
} from "./job-queue-migrations";

/** The committed migration that last touched the pg-boss schema. */
function jobQueueMigration(): string {
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse()
    .find((name) =>
      readFileSync(join(MIGRATIONS_DIR, name), "utf8").includes("pg-boss schema version:"),
    );
  return readFileSync(join(MIGRATIONS_DIR, file!), "utf8");
}

describe("the pg-boss schema in the migrations", () => {
  it("is at the version the installed pg-boss needs (upgrade it with jobs:schema-migration)", () => {
    expect(migratedJobQueueSchemaVersion()).toBe(installedJobQueueSchemaVersion());
  });

  it("is pg-boss's own SQL, without its transaction, and is reversible", () => {
    const migration = jobQueueMigration();
    expect(migration).toContain("-- Up Migration");
    expect(migration).toContain("-- Down Migration");
    expect(migration).toContain("CREATE SCHEMA IF NOT EXISTS pgboss");
    expect(migration).toContain(
      `INSERT INTO pgboss.version(version) VALUES ('${String(installedJobQueueSchemaVersion())}')`,
    );
    expect(migration.split("\n").filter((line) => /^\s*(BEGIN|COMMIT);\s*$/.test(line))).toEqual(
      [],
    );
  });

  it("generates the same migration it generated before", () => {
    const generated = jobQueueSchemaMigration(null);
    const committed = jobQueueMigration();
    const body = (text: string) =>
      text.slice(text.indexOf("CREATE SCHEMA"), text.indexOf("-- Down Migration"));
    expect(body(generated)).toBe(body(committed));
  });
});
