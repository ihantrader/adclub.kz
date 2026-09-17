import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { DatabaseService } from "./database.service";
import { installedJobQueueSchemaVersion } from "../jobs/job-queue-migrations";
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
      "1789627880146_create-session",
      "1789639354506_create-roles",
      "1789644232969_bind-sign-in-step-to-client",
      "1789656263507_create-app-setting",
      "1789660668561_create-job-queue",
      "1789660680048_create-periodic-job-state",
    ]);
  });

  it("rolls back the latest migration only (the periodic job state)", async () => {
    await client.query(
      "INSERT INTO periodic_job_state (name, last_succeeded_at) VALUES ('identity.cleanup-sessions', now())",
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "periodic_job_state")).toBe(false);
  });

  it("rolls back the next one (the job queue schema), keeping the application tables", async () => {
    const schemaExists = async () =>
      (
        await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'")
      ).rowCount === 1;
    expect(await schemaExists()).toBe(true);
    const { rows: version } = await client.query<{ version: number }>(
      "SELECT version FROM pgboss.version",
    );
    expect(version[0]?.version).toBe(installedJobQueueSchemaVersion());
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await schemaExists()).toBe(false);
    expect(await tableExists(client, "app_setting")).toBe(true);
  });

  it("rolls back the next one (settings), keeping everything else", async () => {
    expect(await tableExists(client, "app_setting")).toBe(true);
    await client.query(
      "INSERT INTO app_setting (key, value, version, updated_by_kind) VALUES ('rating_min_reviews', '7', 1, 'operator')",
    );
    await client.query(
      "INSERT INTO app_setting_change (key, version, action, previous_value, previous_is_default, new_value, new_is_default, reason, actor_kind) VALUES ('rating_min_reviews', 1, 'set', '5', true, '7', false, 'test', 'operator')",
    );
    await expect(client.query("DELETE FROM app_setting_change")).rejects.toThrow(/append-only/);
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "app_setting")).toBe(false);
    expect(await tableExists(client, "app_setting_change")).toBe(false);
    const { rows } = await client.query(
      "SELECT 1 FROM pg_proc WHERE proname = 'app_setting_change_immutable'",
    );
    expect(rows).toHaveLength(0);
    expect(await tableExists(client, "sign_in_step")).toBe(true);
  });

  it("rolls back the next one (step client binding), keeping the steps", async () => {
    const hasBinding = async () =>
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name = 'sign_in_step' AND column_name = 'client_binding_hash'",
        )
      ).rowCount === 1;
    expect(await hasBinding()).toBe(true);
    const account = await client.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ('+77010000002') RETURNING id",
    );
    const accountId = account.rows[0]!.id;
    await client.query(
      "INSERT INTO sign_in_step (kind, account_id, token_hash, client_binding_hash, expires_at) VALUES ('supplier_selection', $1, 'hash', 'binding', now() + interval '10 minutes')",
      [accountId],
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await hasBinding()).toBe(false);
    const { rows } = await client.query("SELECT kind FROM sign_in_step WHERE account_id = $1", [
      accountId,
    ]);
    expect(rows).toEqual([{ kind: "supplier_selection" }]);
    await client.query("DELETE FROM sign_in_step WHERE account_id = $1", [accountId]);
    await client.query("DELETE FROM account WHERE id = $1", [accountId]);
  });

  it("rolls back the next one (roles), keeping the sessions and their data", async () => {
    const account = await client.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ('+77010000001') RETURNING id",
    );
    const accountId = account.rows[0]!.id;
    await client.query(
      "INSERT INTO session (account_id, kind, refresh_seed, last_used_at, expires_at, revoked_at, revoked_reason) VALUES ($1, 'mobile', 'seed', now(), now() + interval '1 day', now(), 'totp_reset')",
      [accountId],
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    for (const table of [
      "supplier",
      "supplier_member",
      "admin_user",
      "admin_backup_code",
      "sign_in_step",
    ]) {
      expect(await tableExists(client, table)).toBe(false);
    }
    expect(await tableExists(client, "session")).toBe(true);
    // A session ended for a reason only the newer schema knows survives the rollback.
    const { rows } = await client.query<{ revoked_reason: string }>(
      "SELECT revoked_reason FROM session WHERE account_id = $1",
      [accountId],
    );
    expect(rows).toEqual([{ revoked_reason: "totp_reset" }]);
    await client.query("DELETE FROM session WHERE account_id = $1", [accountId]);
    await client.query("DELETE FROM account WHERE id = $1", [accountId]);
  });

  it("rolls back the next one (sessions)", async () => {
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "session")).toBe(false);
    expect(await tableExists(client, "otp_challenge")).toBe(true);
    expect(await tableExists(client, "account")).toBe(true);
  });

  it("rolls back the next one (login codes)", async () => {
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
    expect(await tableExists(client, "session")).toBe(true);
    expect(await tableExists(client, "supplier_member")).toBe(true);
    expect(await tableExists(client, "admin_user")).toBe(true);
    expect(await tableExists(client, "app_setting")).toBe(true);
    expect(await tableExists(client, "app_setting_change")).toBe(true);
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
