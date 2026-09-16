import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { loadEnvFile } from "../src/config/load-env-file";

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "infra", "migrations");
const MIGRATIONS_TABLE = "pgmigrations";

async function main(): Promise<void> {
  loadEnvFile();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const allFiles = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { rows: tableExists } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists",
      [MIGRATIONS_TABLE],
    );

    const applied = tableExists[0]?.exists
      ? (
          await client.query<{ name: string; run_on: string }>(
            `SELECT name, run_on FROM "${MIGRATIONS_TABLE}" ORDER BY run_on ASC`,
          )
        ).rows
      : [];
    const appliedNames = new Set(applied.map((row) => row.name));

    console.log(`Applied (${applied.length}):`);
    for (const row of applied) {
      console.log(`  [x] ${row.name}  (${row.run_on})`);
    }

    const pending = allFiles.filter((file) => !appliedNames.has(file.replace(/\.sql$/, "")));
    console.log(`Pending (${pending.length}):`);
    for (const file of pending) {
      console.log(`  [ ] ${file.replace(/\.sql$/, "")}`);
    }
  } finally {
    await client.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Failed to read migration status:", error);
  process.exitCode = 1;
});
