import { readdirSync } from "node:fs";
import { Client } from "pg";
import { loadEnvFile } from "./config/load-env-file";
import { MIGRATIONS_DIR, runMigrate } from "./database/migrate-cli";
import {
  installedJobQueueSchemaVersion,
  migratedJobQueueSchemaVersion,
} from "./jobs/job-queue-migrations";

/**
 * The release step of a deployment (TASK-055, ARCHITECTURE 4.82): run in a
 * one-off container of the new `api` image *before* the API and the worker
 * are replaced, so a migration that fails stops the deployment while the
 * old containers keep serving.
 *
 *   node dist/release.js migrate   check the pg-boss schema, apply the
 *                                  migrations, then check nothing is pending
 *   node dist/release.js status    list applied and pending migrations;
 *                                  exits 1 while any is pending
 *
 * Reads `DATABASE_URL` from the environment (no `.env` in the image).
 */

const MIGRATIONS_TABLE = "pgmigrations";

interface MigrationStatus {
  applied: string[];
  pending: string[];
}

async function migrationStatus(databaseUrl: string): Promise<MigrationStatus> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.replace(/\.sql$/, ""))
    .sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const table = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [MIGRATIONS_TABLE],
    );
    const applied = table.rows[0]?.exists
      ? (await client.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`))
          .rows
      : [];
    const names = new Set(applied.map((row) => row.name));
    return {
      applied: applied.map((row) => row.name),
      pending: files.filter((file) => !names.has(file)),
    };
  } finally {
    await client.end();
  }
}

function checkJobQueueSchema(): void {
  const migrated = migratedJobQueueSchemaVersion();
  const installed = installedJobQueueSchemaVersion();
  if (migrated !== installed) {
    throw new Error(
      `pg-boss needs schema version ${installed}, the migrations produce ${migrated ?? "none"}`,
    );
  }
  console.log(`release: pg-boss schema version ${installed} matches the migrations`);
}

function report(status: MigrationStatus): void {
  console.log(
    `release: ${status.applied.length} migrations applied, ${status.pending.length} pending`,
  );
  for (const name of status.pending) {
    console.log(`release:   pending ${name}`);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const command = process.argv[2] ?? "status";
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  if (command === "status") {
    const status = await migrationStatus(databaseUrl);
    report(status);
    if (status.pending.length > 0) process.exitCode = 1;
    return;
  }
  if (command !== "migrate") {
    throw new Error(`unknown command "${command}" (migrate | status)`);
  }
  checkJobQueueSchema();
  const before = await migrationStatus(databaseUrl);
  console.log(`release: applying ${before.pending.length} pending migrations`);
  process.stdout.write(runMigrate("up", databaseUrl));
  const after = await migrationStatus(databaseUrl);
  report(after);
  if (after.pending.length > 0) {
    throw new Error("migrations are still pending after `up`");
  }
  console.log("release: database is ready for this release");
}

main().catch((error: unknown) => {
  // The migration tool's own output already said what failed; the address
  // of the database is never printed.
  console.error(`release: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
