import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { DatabaseService } from "./database.service";
import { runMigrate } from "./migrate-cli";

async function tableExists(client: Client, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists",
    [table],
  );
  return rows[0]?.exists ?? false;
}

/**
 * Real PostgreSQL, no mocks (ARCHITECTURE 15.5, TASK-002 requirement 7):
 * the actual `migrate`/`migrate:down` CLI commands run against a fresh
 * Testcontainers instance, proving the up → status → down → status → up
 * cycle (AC-3/AC-4) and that readiness reflects PostgreSQL going away
 * (AC-2, edge cases) — not simulated versions of that behavior.
 */
describe("PostgreSQL: migrations and readiness", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    // The last test in this suite stops the container on purpose, which
    // kills this connection too — without a listener, pg's 'error' event
    // would crash the process (Node's default for unhandled 'error').
    client.on("error", () => undefined);
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  });

  it("has no application tables before any migration runs", async () => {
    expect(await tableExists(client, "account")).toBe(false);
  });

  it("applies the migration and tracks it in the migrations table", () => {
    const output = runMigrate("up", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
  });

  it("creates the account table a query can actually use", async () => {
    expect(await tableExists(client, "account")).toBe(true);

    const inserted = await client.query<{ id: string; phone: string; status: string }>(
      "INSERT INTO account (phone) VALUES ($1) RETURNING id, phone, status",
      ["+77001234567"],
    );
    expect(inserted.rows[0]).toMatchObject({ phone: "+77001234567", status: "active" });

    const selected = await client.query("SELECT phone FROM account WHERE phone = $1", [
      "+77001234567",
    ]);
    expect(selected.rowCount).toBe(1);
  });

  it("records the applied migrations in the tracking table (status)", async () => {
    const { rows } = await client.query<{ name: string }>('SELECT name FROM "pgmigrations"');
    expect(rows.map((row) => row.name)).toEqual([
      "1789583044021_create-account",
      "1789620211794_create-login-code",
    ]);
  });

  it("rolls back the latest migration only (login codes)", async () => {
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "otp_challenge")).toBe(false);
    expect(await tableExists(client, "phone_verification")).toBe(false);
    expect(await tableExists(client, "account")).toBe(true);
  });

  it("rolls back the rest: the account table (and its data) is gone", async () => {
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "account")).toBe(false);
    const { rows } = await client.query('SELECT name FROM "pgmigrations"');
    expect(rows).toHaveLength(0);
  });

  it("re-applies cleanly and the tables are usable again", async () => {
    const output = runMigrate("up", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "account")).toBe(true);
    expect(await tableExists(client, "otp_challenge")).toBe(true);
  });

  it("readiness reports PostgreSQL as unavailable once it stops, without the process crashing", async () => {
    const databaseService = new DatabaseService(
      loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: container.getConnectionUri(),
        REDIS_URL: "redis://unused",
        S3_ENDPOINT: "http://unused",
        S3_ACCESS_KEY: "x",
        S3_SECRET_KEY: "x",
        S3_BUCKET: "x",
      }),
    );

    expect((await databaseService.checkHealth()).status).toBe("ok");

    await container.stop();

    const downCheck = await databaseService.checkHealth();
    expect(downCheck.status).toBe("error");
    expect(downCheck.error).toBeTruthy();

    await databaseService.pool.end().catch(() => undefined);
  }, 30_000);
});
