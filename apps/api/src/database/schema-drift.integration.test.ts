import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ormTables } from "../orm-tables";
import { runMigrate } from "./migrate-cli";
import { compareSchemas, describeOrmTables, readDatabaseColumns } from "./schema-drift";

/**
 * Debt T-5 (TASK-004): the Drizzle description (`ormTables`) must match the
 * database the SQL migrations actually produce — missing or extra tables
 * and columns, types and nullability. A schema change without a migration
 * (or the other way round) fails CI here with the list of differences.
 */
describe("ORM schema vs migrated database", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    runMigrate("up", container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("describes exactly the tables and columns the migrations create", async () => {
    const problems = compareSchemas(describeOrmTables(ormTables), await readDatabaseColumns(pool));
    expect(problems, `ORM schema and migrations disagree:\n${problems.join("\n")}`).toEqual([]);
  });

  it("detects a column the migrations changed behind the ORM's back", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE otp_challenge ALTER COLUMN channel SET NOT NULL");
      await client.query("ALTER TABLE otp_challenge ADD COLUMN note TEXT");
      await client.query("ALTER TABLE account ALTER COLUMN email TYPE VARCHAR(64)");
      const database = await readDatabaseColumns(client);
      expect(compareSchemas(describeOrmTables(ormTables), database)).toEqual([
        "column account.email: type is text in the ORM but character varying(64) in the database",
        "column otp_challenge.channel: nullable in the ORM but NOT NULL in the database",
        "column otp_challenge.note: exists in the database but is not described in the ORM",
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
