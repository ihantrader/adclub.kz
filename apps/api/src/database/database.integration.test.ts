import { randomUUID } from "node:crypto";
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
    for (let step = 0; step < 20; step += 1) {
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
      "1790100000000_create-vehicles",
      "1790150000000_create-item-compatibility",
      "1790200000000_create-suppliers",
      "1790250000000_supplier-members",
      "1790300000000_create-offers",
      "1790350000000_create-club-access",
      "1790400000000_create-orders",
      "1790450000000_close-orders",
    ]);
  });

  it("holds the rules of giving an order out and rolls back keeping the orders (close orders)", async () => {
    const account = await client.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ('+77470000078') RETURNING id",
    );
    const accountId = account.rows[0]!.id;
    const admin = await client.query<{ id: string }>(
      "INSERT INTO admin_user (account_id) VALUES ($1) RETURNING id",
      [accountId],
    );
    const city = await client.query<{ id: string }>(
      "INSERT INTO city (code, name_ru) VALUES ('close-city', 'Город выдачи') RETURNING id",
    );
    const supplier = await client.query<{ id: string }>(
      "INSERT INTO supplier (name, city_id) VALUES ('Выдача', $1) RETURNING id",
      [city.rows[0]!.id],
    );
    const supplierId = supplier.rows[0]!.id;
    const location = await client.query<{ id: string }>(
      "INSERT INTO supplier_location (supplier_id, city_id) VALUES ($1, $2) RETURNING id",
      [supplierId, city.rows[0]!.id],
    );
    const member = await client.query<{ id: string }>(
      "INSERT INTO supplier_member (supplier_id, account_id, added_by, display_name) VALUES ($1, $2, 'admin', 'Айгерим') RETURNING id",
      [supplierId, accountId],
    );
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('close_node', 'goods', 1) RETURNING id",
    );
    const subcategory = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level, parent_id, parent_level) VALUES ('close_sub', 'goods', 2, $1, 1) RETURNING id",
      [node.rows[0]!.id],
    );
    const brand = await client.query<{ id: string }>(
      "INSERT INTO brand DEFAULT VALUES RETURNING id",
    );
    const item = await client.query<{ id: string }>(
      "INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id) VALUES ('generic', $1, 'goods', $2) RETURNING id",
      [subcategory.rows[0]!.id, brand.rows[0]!.id],
    );
    const itemId = item.rows[0]!.id;
    const offer = await client.query<{ id: string }>(
      "INSERT INTO offer (supplier_id, location_id, item_id, item_type, price, availability, pickup, delivery) VALUES ($1, $2, $3, 'generic', 1000, 'in_stock', true, true) RETURNING id",
      [supplierId, location.rows[0]!.id, itemId],
    );
    let codeCounter = 300_000;
    const insert = (values: Record<string, unknown>) => {
      codeCounter += 1;
      const row: Record<string, unknown> = {
        user_account_id: accountId,
        supplier_id: supplierId,
        location_id: location.rows[0]!.id,
        offer_id: offer.rows[0]!.id,
        item_id: itemId,
        offer_snapshot: "{}",
        unit_price: 1000,
        quantity: 1,
        total: 1000,
        fulfillment: "pickup",
        confirmation_code: String(codeCounter),
        qr_token: `qr-close-${String(codeCounter)}`,
        idempotency_key: randomUUID(),
        respond_by: new Date(Date.now() + 3_600_000),
        ...values,
      };
      const columns = Object.keys(row);
      return client.query<{ id: string }>(
        `INSERT INTO customer_order (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
        Object.values(row),
      );
    };
    const given = {
      status: "completed",
      accepted_at: new Date(),
      phone_revealed_at: new Date(),
      finished_at: new Date(),
      closed_at: new Date(),
      code_released_at: new Date(),
    };
    // «Выдана» always says when, how and by whom.
    await expect(insert({ ...given, close_method: null })).rejects.toThrow(
      /customer_order_close_check/,
    );
    await expect(insert({ ...given, close_method: "code" })).rejects.toThrow(
      /customer_order_close_check/,
    );
    await expect(
      insert({ ...given, close_method: "code", closed_by_admin_id: admin.rows[0]!.id }),
    ).rejects.toThrow(/customer_order_close_check/);
    // A close without a code always says why, and only that one does.
    await expect(
      insert({ ...given, close_method: "admin", closed_by_admin_id: admin.rows[0]!.id }),
    ).rejects.toThrow(/customer_order_close_check/);
    await expect(
      insert({
        ...given,
        close_method: "code",
        closed_by_member_id: member.rows[0]!.id,
        close_reason: "нельзя",
      }),
    ).rejects.toThrow(/customer_order_close_check/);
    // The close belongs to an employee of this very company.
    const otherSupplier = await client.query<{ id: string }>(
      "INSERT INTO supplier (name, city_id) VALUES ('Чужая', $1) RETURNING id",
      [city.rows[0]!.id],
    );
    const otherMember = await client.query<{ id: string }>(
      "INSERT INTO supplier_member (supplier_id, account_id, added_by, display_name) VALUES ($1, $2, 'admin', 'Чужой') RETURNING id",
      [otherSupplier.rows[0]!.id, accountId],
    );
    await expect(
      insert({ ...given, close_method: "code", closed_by_member_id: otherMember.rows[0]!.id }),
    ).rejects.toThrow(/customer_order_closed_by_fkey/);
    // An expired reserve always knows how long it may still be closed.
    await expect(
      insert({
        status: "reserve_expired",
        accepted_at: new Date(),
        phone_revealed_at: new Date(),
        finished_at: new Date(),
      }),
    ).rejects.toThrow(/customer_order_late_close_check/);
    // An order still going on never lets go of its code.
    await expect(insert({ code_released_at: new Date() })).rejects.toThrow(
      /customer_order_code_held_check/,
    );
    // An administrator may close an order the supplier never answered: such
    // an order is «Выдана» without ever having opened the phone.
    const byAdmin = await insert({
      status: "completed",
      finished_at: new Date(),
      closed_at: new Date(),
      close_method: "admin",
      closed_by_admin_id: admin.rows[0]!.id,
      close_reason: "Разбор",
      code_released_at: new Date(),
    });
    // …but no other way to «Выдана» skips the accepting.
    await expect(
      insert({
        status: "completed",
        finished_at: new Date(),
        closed_at: new Date(),
        close_method: "code",
        closed_by_member_id: member.rows[0]!.id,
        code_released_at: new Date(),
      }),
    ).rejects.toThrow(/customer_order_accepted_check/);

    // The code of an order that can still be closed late is nobody else's.
    const expired = await insert({
      status: "reserve_expired",
      accepted_at: new Date(),
      phone_revealed_at: new Date(),
      finished_at: new Date(),
      late_close_until: new Date(Date.now() + 3_600_000),
      confirmation_code: "482915",
    });
    await expect(insert({ confirmation_code: "482915" })).rejects.toThrow(
      /customer_order_held_code_key/,
    );
    await client.query("UPDATE customer_order SET code_released_at = now() WHERE id = $1", [
      expired.rows[0]!.id,
    ]);
    await insert({ confirmation_code: "482915" });

    // The discipline of users and the signals to the administrator.
    const mark = await client.query<{ id: string }>(
      `INSERT INTO user_discipline_event (user_account_id, order_id, supplier_id, kind, occurred_at)
       VALUES ($1, $2, $3, 'pickup_no_show', now()) RETURNING id`,
      [accountId, expired.rows[0]!.id, supplierId],
    );
    await expect(
      client.query(
        `INSERT INTO user_discipline_event (user_account_id, order_id, supplier_id, kind, occurred_at)
         VALUES ($1, $2, $3, 'pickup_no_show', now())`,
        [accountId, expired.rows[0]!.id, supplierId],
      ),
    ).rejects.toThrow(/user_discipline_event_order_key/);
    // A lifting says when and by what; only an administrator's says why.
    await expect(
      client.query("UPDATE user_discipline_event SET revoked_at = now() WHERE id = $1", [
        mark.rows[0]!.id,
      ]),
    ).rejects.toThrow(/user_discipline_event_revoked_check/);
    await expect(
      client.query(
        "UPDATE user_discipline_event SET revoked_at = now(), revoked_by = 'admin' WHERE id = $1",
        [mark.rows[0]!.id],
      ),
    ).rejects.toThrow(/user_discipline_event_revoked_check/);
    await client.query(
      "UPDATE user_discipline_event SET revoked_at = now(), revoked_by = 'late_close' WHERE id = $1",
      [mark.rows[0]!.id],
    );
    await client.query(
      "INSERT INTO admin_signal (kind, subject_type, subject_id) VALUES ('frequent_admin_closes', 'supplier', $1)",
      [supplierId],
    );
    // One open signal of a kind per subject.
    await expect(
      client.query(
        "INSERT INTO admin_signal (kind, subject_type, subject_id) VALUES ('frequent_admin_closes', 'supplier', $1)",
        [supplierId],
      ),
    ).rejects.toThrow(/admin_signal_open_key/);
    await expect(
      client.query(
        "INSERT INTO admin_signal (kind, subject_type, subject_id, status) VALUES ('frequent_admin_closes', 'account', $1, 'open')",
        [supplierId],
      ),
    ).rejects.toThrow(/admin_signal_subject_check/);

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");

    // The discipline and the signals are gone with their tables; the orders
    // stay, and the one an administrator had closed without the supplier's
    // answer is back where it was before such a close was possible.
    expect(await tableExists(client, "user_discipline_event")).toBe(false);
    expect(await tableExists(client, "admin_signal")).toBe(false);
    expect(await columnExists(client, "customer_order", "close_method")).toBe(false);
    expect(await columnExists(client, "customer_order", "late_close_until")).toBe(false);
    const orders = await client.query<{ status: string }>(
      "SELECT status FROM customer_order WHERE id = $1",
      [byAdmin.rows[0]!.id],
    );
    expect(orders.rows).toEqual([{ status: "created" }]);
    const { rows: keys } = await client.query<{ missing: string }>(
      "SELECT count(*)::text AS missing FROM customer_order WHERE idempotency_key IS NULL",
    );
    expect(keys[0]!.missing).toBe("0");

    runMigrate("up", container.getConnectionUri());
    expect(await tableExists(client, "admin_signal")).toBe(true);
    await client.query("DELETE FROM user_discipline_event");
    await client.query("DELETE FROM admin_signal");
    await client.query("DELETE FROM order_event");
    await client.query("DELETE FROM customer_order");
    await client.query("DELETE FROM offer");
    await client.query("DELETE FROM catalog_item");
    await client.query("DELETE FROM brand");
    await client.query("DELETE FROM category WHERE code IN ('close_sub')");
    await client.query("DELETE FROM category WHERE code IN ('close_node')");
    await client.query("DELETE FROM supplier_member");
    await client.query("DELETE FROM admin_user");
    await client.query("DELETE FROM supplier_location");
    await client.query("DELETE FROM supplier");
    await client.query("DELETE FROM city");
    await client.query("DELETE FROM account");
    await walkDownPast(() => tableExists(client, "admin_signal"));
  });

  it("holds the rules of orders and their journal in the database and rolls back keeping the offers (orders)", async () => {
    const account = await client.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ('+77470000077') RETURNING id",
    );
    const accountId = account.rows[0]!.id;
    const city = await client.query<{ id: string }>(
      "INSERT INTO city (code, name_ru) VALUES ('orders-city', 'Город заявок') RETURNING id",
    );
    const supplier = await client.query<{ id: string }>(
      "INSERT INTO supplier (name, city_id) VALUES ('Заявки', $1) RETURNING id",
      [city.rows[0]!.id],
    );
    const supplierId = supplier.rows[0]!.id;
    const location = await client.query<{ id: string }>(
      "INSERT INTO supplier_location (supplier_id, city_id) VALUES ($1, $2) RETURNING id",
      [supplierId, city.rows[0]!.id],
    );
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('orders_node', 'goods', 1) RETURNING id",
    );
    const subcategory = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level, parent_id, parent_level) VALUES ('orders_sub', 'goods', 2, $1, 1) RETURNING id",
      [node.rows[0]!.id],
    );
    const brand = await client.query<{ id: string }>(
      "INSERT INTO brand DEFAULT VALUES RETURNING id",
    );
    const item = await client.query<{ id: string }>(
      "INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id) VALUES ('generic', $1, 'goods', $2) RETURNING id",
      [subcategory.rows[0]!.id, brand.rows[0]!.id],
    );
    const itemId = item.rows[0]!.id;
    const offer = await client.query<{ id: string }>(
      "INSERT INTO offer (supplier_id, location_id, item_id, item_type, price, availability, pickup, delivery) VALUES ($1, $2, $3, 'generic', 1000, 'in_stock', true, true) RETURNING id",
      [supplierId, location.rows[0]!.id, itemId],
    );
    const offerId = offer.rows[0]!.id;
    let codeCounter = 100_000;
    const insert = (values: Record<string, unknown>) => {
      codeCounter += 1;
      const row = {
        user_account_id: accountId,
        supplier_id: supplierId,
        location_id: location.rows[0]!.id,
        offer_id: offerId,
        item_id: itemId,
        offer_snapshot: "{}",
        unit_price: 1000,
        quantity: 2,
        total: 2000,
        fulfillment: "pickup",
        confirmation_code: String(codeCounter),
        qr_token: `qr-${String(codeCounter)}`,
        idempotency_key: randomUUID(),
        respond_by: new Date(Date.now() + 3_600_000),
        ...values,
      };
      const columns = Object.keys(row);
      return client.query<{ id: string; number: string }>(
        `INSERT INTO customer_order (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id, number`,
        Object.values(row),
      );
    };
    await expect(insert({ total: 1999 })).rejects.toThrow(/customer_order_money_check/);
    await expect(insert({ quantity: 0, total: 0 })).rejects.toThrow(/customer_order_money_check/);
    await expect(insert({ confirmation_code: "12a456" })).rejects.toThrow(
      /customer_order_code_check/,
    );
    await expect(insert({ status: "accepted" })).rejects.toThrow(/customer_order_accepted_check/);
    await expect(
      insert({ fulfillment: "delivery", expires_at: new Date(), reserve_warn_at: new Date() }),
    ).rejects.toThrow(/customer_order_reserve_check/);
    await expect(insert({ expires_at: new Date() })).rejects.toThrow(
      /customer_order_reserve_check/,
    );
    await expect(insert({ status: "cancelled_by_user" })).rejects.toThrow(
      /customer_order_finished_check/,
    );
    await expect(insert({ decline_reason: "out_of_stock" })).rejects.toThrow(
      /customer_order_decline_check/,
    );
    const first = await insert({ confirmation_code: "482915" });
    const second = await insert({});
    expect(Number(second.rows[0]!.number)).toBe(Number(first.rows[0]!.number) + 1);
    // One code among active orders; a final one frees it. (TASK-022 widens
    // this rule to «while the order can still be closed» — that migration
    // is already rolled back by the time this test runs, and its own test
    // above checks the wider index.)
    await expect(insert({ confirmation_code: "482915" })).rejects.toThrow(
      /customer_order_active_code_key/,
    );
    await client.query(
      "UPDATE customer_order SET status = 'cancelled_by_user', finished_at = now() WHERE id = $1",
      [first.rows[0]!.id],
    );
    await insert({ confirmation_code: "482915" });
    const key = randomUUID();
    await insert({ idempotency_key: key });
    await expect(insert({ idempotency_key: key })).rejects.toThrow(
      /customer_order_idempotency_key/,
    );

    // The journal: consistent entries, append-only.
    const event = (values: Record<string, unknown>) => {
      const row = {
        order_id: first.rows[0]!.id,
        action: "create",
        to_status: "created",
        actor_type: "user",
        actor_account_id: accountId,
        channel: "app",
        ...values,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO order_event (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    await expect(event({ actor_type: "system" })).rejects.toThrow(/order_event_actor_check/);
    await expect(event({ actor_type: "supplier_member" })).rejects.toThrow(
      /order_event_actor_check/,
    );
    await expect(event({ action: "accept", from_status: null })).rejects.toThrow(
      /order_event_move_check/,
    );
    await expect(event({ action: "reserve_expiring" })).rejects.toThrow(/order_event_move_check/);
    await event({});
    await event({ action: "cancel", from_status: "created", to_status: "cancelled_by_user" });
    await expect(client.query("UPDATE order_event SET channel = 'admin'")).rejects.toThrow(
      /append-only/,
    );
    await expect(client.query("DELETE FROM order_event")).rejects.toThrow(/append-only/);

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");
    expect(await tableExists(client, "customer_order")).toBe(false);
    expect(await tableExists(client, "order_event")).toBe(false);
    const { rows: sequences } = await client.query(
      "SELECT 1 FROM pg_class WHERE relname = 'customer_order_number_seq'",
    );
    expect(sequences).toEqual([]);
    expect(await count("offer", "id = $1", [offerId])).toBe(1);
    expect(await count("account", "id = $1", [accountId])).toBe(1);
    await client.query("DELETE FROM offer WHERE id = $1", [offerId]);
    await client.query("DELETE FROM catalog_item WHERE id = $1", [itemId]);
    await client.query("DELETE FROM brand WHERE id = $1", [brand.rows[0]!.id]);
    await client.query("DELETE FROM category WHERE code IN ('orders_sub')");
    await client.query("DELETE FROM category WHERE code IN ('orders_node')");
    await client.query("DELETE FROM supplier_location WHERE supplier_id = $1", [supplierId]);
    await client.query("DELETE FROM supplier WHERE id = $1", [supplierId]);
    await client.query("DELETE FROM city WHERE id = $1", [city.rows[0]!.id]);
    await client.query("DELETE FROM account WHERE id = $1", [accountId]);
  });

  it("holds the rules of club access grants and rolls back keeping the accounts (club access)", async () => {
    const account = await client.query<{ id: string }>(
      "INSERT INTO account (phone) VALUES ('+77470000001') RETURNING id",
    );
    const accountId = account.rows[0]!.id;
    const grant = (values: Record<string, unknown>) => {
      const row = {
        account_id: accountId,
        valid_until: new Date(Date.now() + 86_400_000),
        reason: "Альфа",
        granted_by_role: "operator",
        ...values,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO club_access_grant (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    await expect(grant({ source: "store" })).rejects.toThrow(/club_access_grant_source_check/);
    await expect(grant({ reason: " " })).rejects.toThrow(/club_access_grant_reason_check/);
    await expect(grant({ granted_by_role: "admin" })).rejects.toThrow(
      /club_access_grant_granted_by_check/,
    );
    await expect(grant({ ended_at: new Date() })).rejects.toThrow(/club_access_grant_ended_check/);
    await grant({});
    // One open grant per account: a second one only after the first is ended.
    await expect(grant({})).rejects.toThrow(/club_access_grant_open_key/);
    await client.query(
      "UPDATE club_access_grant SET ended_at = now(), ended_how = 'replaced', ended_by_role = 'operator', end_reason = 'Новая'",
    );
    await grant({});

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");
    expect(await tableExists(client, "club_access_grant")).toBe(false);
    expect(await count("account", "id = $1", [accountId])).toBe(1);
    await client.query("DELETE FROM account WHERE id = $1", [accountId]);
  });

  it("holds the rules of offers in the database and rolls back keeping the suppliers (offers)", async () => {
    const city = await client.query<{ id: string }>(
      "INSERT INTO city (code, name_ru) VALUES ('offers-city', 'Город предложений') RETURNING id",
    );
    const companies: { supplierId: string; locationId: string }[] = [];
    for (const name of ["Первая", "Вторая"]) {
      const supplier = await client.query<{ id: string }>(
        "INSERT INTO supplier (name, city_id) VALUES ($1, $2) RETURNING id",
        [name, city.rows[0]!.id],
      );
      const location = await client.query<{ id: string }>(
        "INSERT INTO supplier_location (supplier_id, city_id) VALUES ($1, $2) RETURNING id",
        [supplier.rows[0]!.id, city.rows[0]!.id],
      );
      companies.push({ supplierId: supplier.rows[0]!.id, locationId: location.rows[0]!.id });
    }
    const [first, second] = companies as [
      { supplierId: string; locationId: string },
      { supplierId: string; locationId: string },
    ];
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('offers_node', 'goods', 1) RETURNING id",
    );
    const subcategory = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level, parent_id, parent_level) VALUES ('offers_sub', 'goods', 2, $1, 1) RETURNING id",
      [node.rows[0]!.id],
    );
    const brand = await client.query<{ id: string }>(
      "INSERT INTO brand DEFAULT VALUES RETURNING id",
    );
    const item = await client.query<{ id: string }>(
      "INSERT INTO catalog_item (item_type, category_id, category_kind, brand_id) VALUES ('generic', $1, 'goods', $2) RETURNING id",
      [subcategory.rows[0]!.id, brand.rows[0]!.id],
    );
    const itemId = item.rows[0]!.id;
    const insert = (values: Record<string, unknown>) => {
      const row = {
        supplier_id: first.supplierId,
        location_id: first.locationId,
        item_id: itemId,
        item_type: "generic",
        price: 1000,
        availability: "in_stock",
        lead_days: 0,
        pickup: false,
        delivery: true,
        ...values,
      };
      const columns = Object.keys(row);
      return client.query(
        `INSERT INTO offer (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    await expect(insert({ availability: "on_order", lead_days: 0 })).rejects.toThrow(
      /offer_on_order_lead_check/,
    );
    await expect(insert({ delivery: false })).rejects.toThrow(/offer_receipt_check/);
    await expect(insert({ warranty_months: 6, warranty_text: "полгода" })).rejects.toThrow(
      /offer_warranty_check/,
    );
    await expect(insert({ status: "withdrawn" })).rejects.toThrow(/offer_withdrawn_check/);
    await expect(insert({ location_id: second.locationId })).rejects.toThrow(/offer_location_fkey/);
    await expect(insert({ item_type: "part" })).rejects.toThrow(/offer_item_fkey/);
    await insert({});
    await expect(insert({ price: 900 })).rejects.toThrow(/offer_location_item_key/);

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");
    expect(await tableExists(client, "offer")).toBe(false);
    const { rows: keys } = await client.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'supplier_location_id_supplier_key'",
    );
    expect(keys).toEqual([]);
    expect(await count("supplier_location", "city_id = $1", [city.rows[0]!.id])).toBe(2);
    expect(await count("catalog_item", "id = $1", [itemId])).toBe(1);
    await client.query("DELETE FROM catalog_item WHERE id = $1", [itemId]);
    await client.query("DELETE FROM brand WHERE id = $1", [brand.rows[0]!.id]);
    await client.query("DELETE FROM category WHERE code IN ('offers_sub')");
    await client.query("DELETE FROM category WHERE code IN ('offers_node')");
    await client.query("DELETE FROM supplier_location WHERE city_id = $1", [city.rows[0]!.id]);
    await client.query("DELETE FROM supplier WHERE city_id = $1", [city.rows[0]!.id]);
    await client.query("DELETE FROM city WHERE id = $1", [city.rows[0]!.id]);
  });

  it("gives existing companies a contact person and recipients, and rolls back keeping the employees (supplier members)", async () => {
    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");
    expect(await columnExists(client, "supplier_member", "notification_language")).toBe(false);
    const city = await client.query<{ id: string }>(
      "INSERT INTO city (code, name_ru) VALUES ('members-city', 'Город') RETURNING id",
    );
    const company = await client.query<{ id: string }>(
      "INSERT INTO supplier (name, city_id) VALUES ('Компания', $1) RETURNING id",
      [city.rows[0]!.id],
    );
    const supplierId = company.rows[0]!.id;
    const memberIds: string[] = [];
    for (let n = 0; n < 7; n++) {
      const account = await client.query<{ id: string }>(
        "INSERT INTO account (phone) VALUES ($1) RETURNING id",
        [`+7705111000${n}`],
      );
      const removed = n === 0;
      const member = await client.query<{ id: string }>(
        `INSERT INTO supplier_member (supplier_id, account_id, display_name, added_by, status, removed_at, created_at)
         VALUES ($1, $2, $3, 'admin', $4, $5, now() - make_interval(mins => 100 - $6::int)) RETURNING id`,
        [
          supplierId,
          account.rows[0]!.id,
          `Сотрудник ${n}`,
          removed ? "removed" : "active",
          removed ? new Date() : null,
          n,
        ],
      );
      memberIds.push(member.rows[0]!.id);
    }

    expect(runMigrate("up", container.getConnectionUri())).toContain("Migrations complete");
    const { rows } = await client.query<{
      id: string;
      is_contact_person: boolean;
      on: boolean;
      notification_language: string;
    }>(
      `SELECT id, is_contact_person, notifications_enabled_at IS NOT NULL AS on, notification_language
       FROM supplier_member WHERE supplier_id = $1 ORDER BY created_at`,
      [supplierId],
    );
    // The removed one is neither; the first active one is the contact person;
    // the first five active ones receive notifications.
    expect(rows.map((row) => [row.is_contact_person, row.on])).toEqual([
      [false, false],
      [true, true],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, false],
    ]);
    expect(new Set(rows.map((row) => row.notification_language))).toEqual(new Set(["ru"]));
    // A second contact person of one company is refused by the database.
    await expect(
      client.query("UPDATE supplier_member SET is_contact_person = true WHERE id = $1", [
        memberIds[2],
      ]),
    ).rejects.toThrow(/supplier_member_contact_person_key/);
    await client.query(
      "INSERT INTO supplier_invitation (supplier_id, member_id, status) VALUES ($1, $2, 'cancelled')",
      [supplierId, memberIds[1]],
    );

    await walkDownPast(() => columnExists(client, "supplier_member", "is_contact_person"));
    expect(await columnExists(client, "supplier_member", "is_contact_person")).toBe(false);
    expect(await count("supplier_member", "supplier_id = $1", [supplierId])).toBe(7);
    // A value the old list doesn't know stays in its row.
    expect(await count("supplier_invitation", "status = 'cancelled'")).toBe(1);
    await client.query("DELETE FROM supplier_invitation");
    await client.query("DELETE FROM supplier_member");
    await client.query("DELETE FROM supplier_location");
    await client.query("DELETE FROM supplier");
    await client.query("DELETE FROM account WHERE phone LIKE '+7705111000%'");
    await client.query("DELETE FROM city");
  });

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return rows[0]!.n;
  }

  it("moves the city text of companies into the directory and back (suppliers), losing nothing", async () => {
    // Companies of before the directory: written with the city as text.
    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");
    expect(await tableExists(client, "city")).toBe(false);
    const insert = async (name: string, city: string, status = "active") =>
      (
        await client.query<{ id: string }>(
          "INSERT INTO supplier (name, city, status) VALUES ($1, $2, $3) RETURNING id",
          [name, city, status],
        )
      ).rows[0]!.id;
    const alpha = await insert("Альфа", "алматы");
    const beta = await insert("Бета", "Almaty", "paused");
    const gamma = await insert("Гамма", "Неизвестград");
    const delta = await insert("Дельта", " неизвестград ", "draft");
    const epsilon = await insert("Эпсилон", "Өскемен", "blocked");

    expect(runMigrate("up", container.getConnectionUri())).toContain("Migrations complete");
    // Known names became the city with its code and three names; any other
    // text a city of its own with that text as the Russian name.
    const { rows: cities } = await client.query(
      "SELECT code, name_ru, name_kk, name_en, source, status FROM city ORDER BY code",
    );
    expect(cities).toEqual([
      {
        code: "almaty",
        name_ru: "Алматы",
        name_kk: "Алматы",
        name_en: "Almaty",
        source: "migrated",
        status: "active",
      },
      {
        code: "migrated-1",
        name_ru: "Неизвестград",
        name_kk: null,
        name_en: null,
        source: "migrated",
        status: "active",
      },
      {
        code: "ust-kamenogorsk",
        name_ru: "Усть-Каменогорск",
        name_kk: "Өскемен",
        name_en: "Oskemen",
        source: "migrated",
        status: "active",
      },
    ]);
    const { rows: suppliers } = await client.query(
      `SELECT s.name, c.code, s.status, s.pause_reason, s.block_reason IS NOT NULL AS blocked, s.type,
              (SELECT count(*)::int FROM supplier_location l WHERE l.supplier_id = s.id AND l.city_id = s.city_id) AS points
       FROM supplier s JOIN city c ON c.id = s.city_id ORDER BY s.name`,
    );
    expect(suppliers).toEqual([
      {
        name: "Альфа",
        code: "almaty",
        status: "active",
        pause_reason: null,
        blocked: false,
        type: "both",
        points: 1,
      },
      {
        name: "Бета",
        code: "almaty",
        status: "paused",
        pause_reason: "admin",
        blocked: false,
        type: "both",
        points: 1,
      },
      {
        name: "Гамма",
        code: "migrated-1",
        status: "active",
        pause_reason: null,
        blocked: false,
        type: "both",
        points: 1,
      },
      {
        name: "Дельта",
        code: "migrated-1",
        status: "active",
        pause_reason: null,
        blocked: false,
        type: "both",
        points: 1,
      },
      {
        name: "Эпсилон",
        code: "ust-kamenogorsk",
        status: "blocked",
        pause_reason: null,
        blocked: true,
        type: "both",
        points: 1,
      },
    ]);

    // Back: every company has its city as text again (the directory's
    // Russian name), and its state. (The `up` above brought the later
    // migrations back too.)
    await walkDownPast(() => tableExists(client, "city"));
    expect(await tableExists(client, "city")).toBe(false);
    expect(await tableExists(client, "supplier_lead")).toBe(false);
    const { rows: back } = await client.query(
      "SELECT id, city, status FROM supplier ORDER BY name",
    );
    expect(back).toEqual([
      { id: alpha, city: "Алматы", status: "active" },
      { id: beta, city: "Алматы", status: "paused" },
      { id: gamma, city: "Неизвестград", status: "active" },
      { id: delta, city: "Неизвестград", status: "active" },
      { id: epsilon, city: "Усть-Каменогорск", status: "blocked" },
    ]);
    await client.query("DELETE FROM supplier");
  });

  it("rolls back the next one (compatibility), keeping items and cars", async () => {
    const node = await client.query<{ id: string }>(
      "INSERT INTO category (code, kind, level) VALUES ('fit_node', 'goods', 1) RETURNING id",
    );
    const pads = await client.query<{ id: string }>(
      `INSERT INTO category (code, kind, level, parent_id, parent_level)
       VALUES ('fit_pads', 'goods', 2, $1, 1) RETURNING id`,
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
    const make = await client.query<{ id: string }>(
      "INSERT INTO vehicle_make DEFAULT VALUES RETURNING id",
    );
    const record = await client.query<{ id: string }>(
      `INSERT INTO item_compatibility (item_id, item_type, make_id, source, evidence)
       VALUES ($1, 'part', $2, 'admin', 'catalog') RETURNING id`,
      [item.rows[0]!.id, make.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO item_compatibility_proposal (item_id, item_type, make_id, evidence, source, status, resolution, compatibility_id, reviewed_at)
       VALUES ($1, 'part', $2, 'catalog', 'ai', 'approved', 'already_approved', $3, now())`,
      [item.rows[0]!.id, make.rows[0]!.id, record.rows[0]!.id],
    );

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");

    // Compatibility is gone with its tables, triggers and the key on items;
    // the item and the make stay.
    expect(await tableExists(client, "item_compatibility")).toBe(false);
    expect(await tableExists(client, "item_compatibility_proposal")).toBe(false);
    const { rows: functions } = await client.query(
      "SELECT proname FROM pg_proc WHERE proname LIKE 'item_compatibility_%'",
    );
    expect(functions).toEqual([]);
    const { rows: keys } = await client.query(
      "SELECT conname FROM pg_constraint WHERE conname = 'catalog_item_id_type_key'",
    );
    expect(keys).toEqual([]);
    expect((await client.query("SELECT article FROM catalog_item")).rows).toEqual([
      { article: "04465-0K090" },
    ]);
    expect((await client.query("SELECT id FROM vehicle_make")).rows).toHaveLength(1);

    runMigrate("up", container.getConnectionUri());
    expect(await tableExists(client, "item_compatibility")).toBe(true);
    await client.query("DELETE FROM vehicle_make");
    await client.query("DELETE FROM catalog_item");
    await client.query("DELETE FROM brand");
    await client.query("DELETE FROM category");
    await walkDownPast(() => tableExists(client, "item_compatibility"));
  });

  it("rolls back the next one (the vehicle catalog), keeping the catalog", async () => {
    await client.query(
      "INSERT INTO category (code, kind, level) VALUES ('vehicle_node', 'goods', 1)",
    );
    const [body, drive, transmission, fuel] = await Promise.all(
      [
        ["body", "sedan"],
        ["drive", "fwd"],
        ["transmission", "at"],
        ["fuel", "petrol"],
      ].map(async ([kind, code]) => {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO vehicle_option (kind, code, name_ru) VALUES ($1, $2, $2) RETURNING id",
          [kind, code],
        );
        return rows[0]!.id;
      }),
    );
    const make = await client.query<{ id: string }>(
      "INSERT INTO vehicle_make DEFAULT VALUES RETURNING id",
    );
    const model = await client.query<{ id: string }>(
      "INSERT INTO vehicle_model (make_id) VALUES ($1) RETURNING id",
      [make.rows[0]!.id],
    );
    const generation = await client.query<{ id: string }>(
      "INSERT INTO vehicle_generation (model_id, name, name_key, year_from) VALUES ($1, 'I', 'i', 2019) RETURNING id",
      [model.rows[0]!.id],
    );
    const engine = await client.query<{ id: string }>(
      "INSERT INTO vehicle_engine (fuel_id) VALUES ($1) RETURNING id",
      [fuel],
    );
    await client.query(
      `INSERT INTO vehicle_modification (generation_id, body_type_id, engine_id, transmission_type_id, drive_type_id, year_from, market)
       VALUES ($1, $2, $3, $4, $5, 2020, 'kz')`,
      [generation.rows[0]!.id, body, engine.rows[0]!.id, transmission, drive],
    );

    expect(runMigrate("down", container.getConnectionUri())).toContain("Migrations complete");

    // The vehicle catalog is gone with its tables and triggers; the catalog of goods stays.
    for (const table of [
      "vehicle_modification",
      "vehicle_option",
      "vehicle_import",
      "vehicle_make",
    ]) {
      expect(await tableExists(client, table)).toBe(false);
    }
    const { rows: functions } = await client.query(
      "SELECT proname FROM pg_proc WHERE proname LIKE 'vehicle_%'",
    );
    expect(functions).toEqual([]);
    const categories = await client.query("SELECT code FROM category");
    expect(categories.rows).toEqual([{ code: "vehicle_node" }]);

    runMigrate("up", container.getConnectionUri());
    expect(await tableExists(client, "vehicle_modification")).toBe(true);
    await client.query("DELETE FROM category");
    await walkDownPast(() => tableExists(client, "vehicle_option"));
  });

  it("rolls back the next one (photos of items), keeping the items", async () => {
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
