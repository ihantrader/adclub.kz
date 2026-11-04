import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import migratePkg from "node-pg-migrate/package.json";

/** For integration tests: the real `infra/migrations` and migration CLI. */
export const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "..", "infra", "migrations");

// Resolved via package.json rather than `require.resolve("node-pg-migrate/bin/...")`
// directly: Vitest's module resolution mishandles that subpath.
const migratePkgDir = dirname(require.resolve("node-pg-migrate/package.json"));
const MIGRATE_BIN = resolve(migratePkgDir, migratePkg.bin["node-pg-migrate"]);

/** Runs `node-pg-migrate up|down` against `databaseUrl`, as `pnpm migrate` does. */
export function runMigrate(command: "up" | "down", databaseUrl: string, count?: number): string {
  const args = [MIGRATE_BIN, command, "-m", MIGRATIONS_DIR];
  if (count !== undefined) {
    args.push(String(count));
  }
  return execFileSync(process.execPath, args, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf-8",
  });
}

/**
 * The same, without blocking the event loop — for a test whose API and
 * workers live in this very process: a sweeper caught mid-transaction by a
 * synchronous child process can never commit, and a `DROP TABLE` of the
 * migration waits for its lock forever (TASK-051 acceptance).
 */
export async function runMigrateAsync(
  command: "up" | "down",
  databaseUrl: string,
  count?: number,
): Promise<string> {
  const args = [MIGRATE_BIN, command, "-m", MIGRATIONS_DIR];
  if (count !== undefined) {
    args.push(String(count));
  }
  const { stdout } = await promisify(execFile)(process.execPath, args, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf-8",
  });
  return stdout;
}
