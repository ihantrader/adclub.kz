import { execFileSync } from "node:child_process";
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
