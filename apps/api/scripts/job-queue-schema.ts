import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installedJobQueueSchemaVersion,
  jobQueueSchemaMigration,
  migratedJobQueueSchemaVersion,
} from "../src/jobs/job-queue-migrations";
import { JOB_QUEUE_SCHEMA } from "../src/jobs/job-queue-schema";
import { MIGRATIONS_DIR } from "../src/database/migrate-cli";

/**
 * The pg-boss schema is part of the project migrations (ARCHITECTURE 4.12
 * I112): pg-boss never installs or upgrades it by itself (`migrate: false`).
 *
 *   check     fails when the installed pg-boss needs a schema version the
 *             migrations don't produce (also a unit test)
 *   generate  writes the migration that brings the schema to the version the
 *             installed pg-boss needs (after upgrading the dependency)
 *
 * `pnpm --filter api jobs:schema-migration [check|generate]`
 */
function main(): void {
  const command = process.argv[2] ?? "check";
  const migrated = migratedJobQueueSchemaVersion();
  const installed = installedJobQueueSchemaVersion();
  if (migrated === installed) {
    console.log(
      `pg-boss schema "${JOB_QUEUE_SCHEMA}" version ${installed}: migrations are up to date.`,
    );
    return;
  }
  if (command !== "generate") {
    console.error(
      `pg-boss needs schema version ${installed}, the migrations produce ${migrated ?? "none"}. ` +
        "Run `pnpm --filter api jobs:schema-migration generate` and commit the new migration.",
    );
    process.exitCode = 1;
    return;
  }
  const name = migrated === null ? "create-job-queue" : `upgrade-job-queue-to-${String(installed)}`;
  const file = join(MIGRATIONS_DIR, `${Date.now()}_${name}.sql`);
  writeFileSync(file, jobQueueSchemaMigration(migrated), "utf8");
  console.log(`Written ${file}`);
}

main();
