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

async function columnExists(client: Client, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = $1 AND column_name = $2) AS exists`,
    [table, column],
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

  /**
   * Rolls migrations back until `stillThere` says the thing this test put
   * on the database is gone. The tests below walk down one migration per
   * test, and a `runMigrate("up")` in the middle brings back every later
   * migration too — this keeps that from shifting the ones that follow.
   */
  async function walkDownPast(stillThere: () => Promise<boolean>): Promise<void> {
    for (let step = 0; step < 10; step += 1) {
      runMigrate("down", container.getConnectionUri());
      if (!(await stillThere())) {
        return;
      }
    }
    throw new Error("The migrations did not walk back down");
  }

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
      "1789660681238_add-sign-in-data-cleanup-indexes",
      "1789677720444_create-audit-log",
      "1789740000000_create-catalog-structure",
      "1789830000000_create-catalog-items",
      "1789900000000_create-ai-jobs-and-translation-tasks",
      "1789990000000_ai-through-openrouter",
      "1790050000000_create-item-photos",
    ]);
  });

  it("rolls back the latest migration only (photos of items), keeping the items", async () => {
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('photo_node', 'goods', 1) RETURNING id",
    );
    const pads = await client.query<{ id: string }>(
      `INSERT INTO category (code, kind, level, parent_id, parent_level)
       VALUES ('photo_pads', 'goods', 2, $1, 1) RETURNING id`,
      [node.rows[0]!.id],
    );
    const brand = await client.query<{ id: string }>(
      "INSERT INTO brand (is_oem) VALUES (true) RETURNING id",
    );
    const item = await client.query<{ id: string }>(
      `INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id, article, article_norm)
       VALUES ('part', $1, 'goods', $2, '04465-0K090', '044650K090') RETURNING id`,
      [pads.rows[0]!.id, brand.rows[0]!.id],
    );
    const photo = await client.query<{ id: string }>(
      `INSERT INTO item_photo (item_id, source_type, content_type, byte_size, width, height, checksum)
       VALUES ($1, 'admin_upload', 'image/jpeg', 1000, 800, 600, repeat('a', 64)) RETURNING id`,
      [item.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO item_photo_file (photo_id, variant, storage_key, content_type, byte_size, width, height)
       VALUES ($1, 'original', 'catalog-photos/x/y/original.jpg', 'image/jpeg', 1000, 800, 600)`,
      [photo.rows[0]!.id],
    );
    await client.query("UPDATE catalog_item SET primary_photo_id = $1 WHERE id = $2", [
      photo.rows[0]!.id,
      item.rows[0]!.id,
    ]);

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");

    // The photos are gone with their tables; the item they belonged to stays.
    expect(await tableExists(client, "item_photo")).toBe(false);
    expect(await tableExists(client, "item_photo_file")).toBe(false);
    expect(await columnExists(client, "catalog_item", "primary_photo_id")).toBe(false);
    const items = await client.query("SELECT article FROM catalog_item");
    expect(items.rows).toEqual([{ article: "04465-0K090" }]);

    runMigrate("up", container.getConnectionUri());
    expect(await tableExists(client, "item_photo")).toBe(true);
    await client.query("DELETE FROM catalog_item");
    await client.query("DELETE FROM brand");
    await client.query("DELETE FROM category");
    await walkDownPast(() => tableExists(client, "item_photo"));
  });

  it("rolls back the next one (AI through OpenRouter), keeping the calls", async () => {
    await client.query(
      `INSERT INTO ai_job (kind, provider, model, initiator_type, status, finished_at,
                           cost_usd, cost_is_estimate, is_fallback)
       VALUES ('translate', 'openrouter', 'google/gemini-3.8-flash', 'system', 'succeeded', now(),
               0.05, true, true)`,
    );
    const account = await client.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ('+77011234567') RETURNING id",
    );
    const entityId = "00000000-0000-4000-8000-000000000009";
    await client.query(
      `INSERT INTO translation_task (entity_type, entity_id, field, lang, source_hash, requested_by)
       VALUES ('category', $1, 'name', 'kk', 'hash', $2)`,
      [entityId, account.rows[0]!.id],
    );
    // A failure that only the new schema knows.
    await client.query(
      `INSERT INTO ai_job (kind, provider, model, initiator_type, status, error_kind, error, finished_at)
       VALUES ('translate', 'openrouter', 'missing/model', 'system', 'failed',
               'no_private_provider', 'nothing was sent', now())`,
    );
    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");
    // The columns are gone; the calls themselves and their history stay.
    const calls = await client.query("SELECT * FROM ai_job ORDER BY created_at");
    expect(calls.rows).toHaveLength(2);
    expect(Object.keys(calls.rows[0]!)).not.toContain("cost_is_estimate");
    expect(Object.keys(calls.rows[0]!)).not.toContain("is_fallback");
    const tasks = await client.query("SELECT * FROM translation_task");
    expect(Object.keys(tasks.rows[0]!)).not.toContain("requested_by");
    // And it goes up again on its own; the columns come back with their
    // defaults (what a dropped column held is gone — the calls are not).
    runMigrate("up", container.getConnectionUri());
    const back = await client.query("SELECT cost_is_estimate, is_fallback FROM ai_job");
    expect(back.rows).toHaveLength(2);
    expect(back.rows[0]).toMatchObject({ cost_is_estimate: false, is_fallback: false });
    expect(await columnExists(client, "translation_task", "requested_by")).toBe(true);
    await client.query("DELETE FROM translation_task");
    await client.query("DELETE FROM ai_job");
    await client.query("DELETE FROM account");
    // The tests below walk down one migration at a time, so leave the database
    // where this one found it: `up` brought back every migration, not just this.
    await walkDownPast(() => columnExists(client, "ai_job", "cost_is_estimate"));
  });

  it("rolls back the next one (AI calls and translation tasks), keeping the texts", async () => {
    const job = await client.query<{ id: string }>(
      `INSERT INTO ai_job (kind, provider, model, initiator_type, status, finished_at)
       VALUES ('translate', 'test', 'claude-sonnet-5', 'system', 'succeeded', now()) RETURNING id`,
    );
    const entityId = "00000000-0000-4000-8000-000000000001";
    await client.query(
      `INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited, source_hash, ai_model, ai_job_id)
       VALUES ('category', $1, 'name', 'en', 'Brakes', 'ai', false, 'hash', 'claude-sonnet-5', $2),
              ('category', $1, 'name', 'ru', 'Тормоза', 'source', true, NULL, NULL, NULL)`,
      [entityId, job.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO translation_task (entity_type, entity_id, field, lang, source_hash)
       VALUES ('category', $1, 'name', 'kk', 'hash')`,
      [entityId],
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "ai_job")).toBe(false);
    expect(await tableExists(client, "translation_task")).toBe(false);
    // The texts stay (an automatic one keeps its origin); only the columns of the call are gone.
    const texts = await client.query("SELECT * FROM translation WHERE entity_id = $1", [entityId]);
    expect(texts.rows.map((row) => row.lang).sort()).toEqual(["en", "ru"]);
    expect(Object.keys(texts.rows[0]!)).not.toContain("ai_model");
    expect(Object.keys(texts.rows[0]!)).not.toContain("ai_job_id");
    // And it goes up again on its own (the suite goes on from the state before).
    runMigrate("up", container.getConnectionUri());
    expect(await tableExists(client, "translation_task")).toBe(true);
    await client.query("DELETE FROM translation_task");
    await client.query("DELETE FROM translation");
    await client.query("DELETE FROM ai_job");
    await walkDownPast(() => tableExists(client, "ai_job"));
  });

  it("rolls back the next one (catalog items), keeping the structure", async () => {
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('brakes', 'goods', 1) RETURNING id",
    );
    const pads = await client.query<{ id: string }>(
      `INSERT INTO category (code, kind, level, parent_id, parent_level)
       VALUES ('brake_pads', 'goods', 2, $1, 1) RETURNING id`,
      [node.rows[0]!.id],
    );
    const axle = await client.query<{ id: string }>(
      `INSERT INTO attribute (category_id, code, value_type) VALUES ($1, 'axle', 'enum') RETURNING id`,
      [pads.rows[0]!.id],
    );
    const front = await client.query<{ id: string }>(
      "INSERT INTO attribute_option (attribute_id, code) VALUES ($1, 'front') RETURNING id",
      [axle.rows[0]!.id],
    );
    const brand = await client.query<{ id: string }>(
      "INSERT INTO brand DEFAULT VALUES RETURNING id",
    );
    await client.query(
      "INSERT INTO brand_spelling (brand_id, text, key, is_name) VALUES ($1, 'Geely', 'geely', true)",
      [brand.rows[0]!.id],
    );
    const items: string[] = [];
    for (const article of ["04465-0K090", "GDB3534"]) {
      const item = await client.query<{ id: string }>(
        `INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id, article, article_norm)
         VALUES ('part', $1, 'goods', $2, $3, $4) RETURNING id`,
        [pads.rows[0]!.id, brand.rows[0]!.id, article, article.replace(/[^A-Z0-9]/g, "")],
      );
      items.push(item.rows[0]!.id);
      await client.query(
        `INSERT INTO item_attribute_value (item_id, attribute_id, attribute_value_type, value_option_id, source)
         VALUES ($1, $2, 'enum', $3, 'admin')`,
        [item.rows[0]!.id, axle.rows[0]!.id, front.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited)
         VALUES ('catalog_item', $1, 'name', 'ru', 'Колодки', 'source', true)`,
        [item.rows[0]!.id],
      );
    }
    items.sort();
    await client.query(
      "INSERT INTO item_analog (item_id, analog_item_id, category_id) VALUES ($1, $2, $3)",
      [items[0], items[1], pads.rows[0]!.id],
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    for (const table of [
      "brand",
      "brand_spelling",
      "catalog_item",
      "item_attribute_value",
      "item_analog",
    ]) {
      expect(await tableExists(client, table), table).toBe(false);
    }
    // The structure stays; the items' names go with them.
    expect(await tableExists(client, "category")).toBe(true);
    const texts = await client.query("SELECT entity_type FROM translation");
    expect(texts.rows).toEqual([]);
    await client.query("DELETE FROM attribute_option");
    await client.query("DELETE FROM attribute");
    await client.query("DELETE FROM category WHERE level = 2");
    await client.query("DELETE FROM category");
  });

  it("rolls back the next one (the catalog structure), keeping the journal", async () => {
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('brakes', 'goods', 1) RETURNING id",
    );
    await client.query(
      `INSERT INTO translation (entity_type, entity_id, field, lang, text, origin, is_manually_edited)
       VALUES ('category', $1, 'name', 'ru', 'Тормоза', 'source', true)`,
      [node.rows[0]!.id],
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    for (const table of ["category", "attribute", "attribute_option", "translation"]) {
      expect(await tableExists(client, table), table).toBe(false);
    }
    expect(await tableExists(client, "audit_log")).toBe(true);
  });

  it("rolls back the next one (the action journal), keeping the tables", async () => {
    await client.query(
      `INSERT INTO audit_log (action, actor_role, entity_type, entity_id)
       VALUES ('setting.changed', 'operator', 'setting', 'supplier_response_hours')`,
    );
    // The journal takes no change and no deletion, whoever asks.
    await expect(client.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "audit_log")).toBe(false);
    expect(await tableExists(client, "session")).toBe(true);
  });

  it("rolls back the next one (the cleanup indexes), keeping the tables", async () => {
    const indexExists = async (name: string) =>
      (await client.query("SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = $1", [name]))
        .rowCount === 1;
    expect(await indexExists("session_ended_at_idx")).toBe(true);
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await indexExists("session_ended_at_idx")).toBe(false);
    expect(await indexExists("otp_challenge_ended_at_idx")).toBe(false);
    expect(await tableExists(client, "session")).toBe(true);
  });

  it("rolls back the next one (the periodic job state)", async () => {
    await client.query(
      "INSERT INTO periodic_job_state (name, last_succeeded_at) VALUES ('identity.cleanup-sessions', now())",
    );
    const output = runMigrate("down", container.getConnectionUri());
    expect(output).toContain("Migrations complete");
    expect(await tableExists(client, "periodic_job_state")).toBe(false);
  });

  it("rolls back the next one (the job queue schema), keeping the application tables", async () => {
    const schemaExists = async () =>
      (await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'"))
        .rowCount === 1;
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
    expect(await tableExists(client, "catalog_item")).toBe(true);
    expect(await tableExists(client, "item_analog")).toBe(true);
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
